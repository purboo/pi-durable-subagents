// Private ledger entries: create-intent {rid,wid,origin,cwd,pins} is the recoverable
// P11 snapshot; pins contain script, args, agents and base64 inputs. Workflow
// wf-created {rid,origin,cwd,revision} precedes JT.created in the orch ledger.
// staging/<rid>/snapshot.json binds the first observed request hash and complete
// pins (or pin error) before admission. Derived files are rebuildable from it;
// failure.json makes a snapshot whose derived files cannot be published fail closed.
import { readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverAgents, type AgentDefinition, type DiscoveryOptions } from '../compat/agents.ts';
import { compileFanout } from '../compat/fanout.ts';
import { contentHash, ulid } from '../kernel/ids.ts';
import { openJournal, syncDirectory } from '../kernel/journal.ts';
import { publishFile } from '../kernel/mailbox.ts';
import { journalPath, pinnedDir } from '../paths.ts';
import { JT, type Entry, type JournalHandle, type Request, type RunBody } from '../types.ts';
import type { Ledgers } from './contract.ts';

export interface Pins { source: string; args: unknown; agents: AgentDefinition[]; inputs: Record<string, string> }
export interface Workflow { wid: string; origin: string; cwd: string; journal: JournalHandle; pins: Pins; scriptPath: string; inputs: Record<string, string> }

/** P11, A5: Capture immutable admission inputs before publishing any workflow files. */
export async function prepareRun(body: RunBody, discovery?: DiscoveryOptions): Promise<Pins> {
  if (!body || typeof body.cwd !== 'string' || [body.workflow, body.source, body.tasks, body.chain, body.call].filter(x => x !== undefined).length !== 1) throw new Error('invalid-run');
  const source = body.source ?? (body.workflow ? await readFile(body.workflow, 'utf8') : compileFanout(body.tasks ? { tasks: body.tasks } : body.chain ? { chain: body.chain } : { tasks: [body.call!] }).source);
  const inputs: Record<string, string> = Object.create(null);
  for (const [name, file] of Object.entries(body.inputs ?? {})) inputs[name] = (await readFile(file)).toString('base64');
  const found = discoverAgents(body.cwd, discovery);
  if (found.diagnostics.length) throw new Error(found.diagnostics.map(d => `${d.sourcePath}: ${d.error}`).join('\n'));
  return { source, args: body.args ?? null, agents: found.agents, inputs };
}

/** A1, P11: Own shared workflow handles and reconcile create intents after a crash. */
export class Store {
  readonly workflows = new Map<string, Workflow>();
  private ledgers: Ledgers;
  constructor(ledgers: Ledgers) { this.ledgers = ledgers; }
  private stagePath(rid: string) {
    if (!rid || rid === '.' || rid === '..') throw new Error('Invalid staging identity');
    return join(this.ledgers.home, 'staging', encodeURIComponent(rid));
  }
  /** P11: Publish the first observed snapshot before admission; never reopen external sources after staging exists. */
  async stage(req: Request<RunBody>, discovery?: DiscoveryOptions): Promise<void> {
    const dir = this.stagePath(req.rid);
    // Only a committed snapshot binds the request; a crash inside publishFile leaves at most a temp file, and
    // nothing was admitted yet, so reading the sources again is still the first observation.
    let exists = true;
    try { await stat(join(dir, 'snapshot.json')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false; }
    if (!exists) {
      let snapshot: { hash: string; pins?: Pins; error?: string };
      try { snapshot = { hash: contentHash(req), pins: await prepareRun(req.body, discovery) }; }
      catch (error) { snapshot = { hash: contentHash(req), error: String(error) }; }
      await publishFile(dir, 'snapshot.json', JSON.stringify(snapshot));
      await syncDirectory(join(this.ledgers.home, 'staging'));
    }
    // A partial directory without a committed snapshot fails closed instead of re-reading sources.
    try {
      const pins = await this.staged(req);
      for (const [name, bytes] of Object.entries({ 'script.js': pins.source, 'args.json': JSON.stringify(pins.args), 'agents.json': JSON.stringify(pins.agents) })) {
        if (await publishFile(dir, name, bytes) === 'conflict') throw new Error(`Staging conflict: ${name}`);
      }
      for (const [name, bytes] of Object.entries(pins.inputs)) {
        const file = encodeURIComponent(name);
        if (!file || file === '.' || file === '..') throw new Error('Invalid input name');
        if (await publishFile(join(dir, 'inputs'), file, Buffer.from(bytes, 'base64')) === 'conflict') throw new Error(`Staging input conflict: ${name}`);
      }
      await syncDirectory(dir);
    } catch (error) {
      await publishFile(dir, 'failure.json', JSON.stringify({ error: String(error) }));
    }
  }
  /** P11: Resolve admission only from the durable staging snapshot. */
  async staged(req: Request<RunBody>): Promise<Pins> {
    const dir = this.stagePath(req.rid);
    const failure = await readFile(join(dir, 'failure.json'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
    if (failure) throw new Error(JSON.parse(failure).error);
    const snapshot = JSON.parse(await readFile(join(dir, 'snapshot.json'), 'utf8')) as { hash: string; pins?: Pins; error?: string };
    if (snapshot.hash !== contentHash(req)) throw new Error('Staging identity conflict');
    if (!snapshot.pins) throw new Error(snapshot.error ?? 'Incomplete staging');
    return snapshot.pins;
  }
  /** P3, P6: Remove staging only after a durable rejection or withdrawal. */
  async discardStage(rid: string): Promise<void> {
    await rm(this.stagePath(rid), { recursive: true, force: true });
    await syncDirectory(join(this.ledgers.home, 'staging')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  /** A5: Fix the workflow identity and snapshot before filesystem effects. */
  async create(req: Request<RunBody>, pins: Pins): Promise<Workflow> {
    let intent = this.ledgers.orch.entries().find(e => e.type === 'create-intent' && e.rid === req.rid);
    intent ??= await this.ledgers.orch.append('create-intent', { rid: req.rid, wid: ulid(), origin: req.from, cwd: req.body.cwd, pins });
    return this.materialize(intent);
  }
  /** A1, A5: Complete interrupted publications from the committed snapshot. */
  async recover(): Promise<void> {
    for (const intent of this.ledgers.orch.entries().filter(e => e.type === 'create-intent')) await this.materialize(intent);
  }
  private async materialize(intent: Entry): Promise<Workflow> {
    const wid = intent.wid as string;
    const existing = this.workflows.get(wid);
    if (existing) return existing;
    const pins = intent.pins as Pins, dir = pinnedDir(this.ledgers.home, wid);
    const publish = async (directory: string, name: string, bytes: string | Buffer) => {
      if (await publishFile(directory, name, bytes) === 'conflict') throw new Error(`Pinned content conflict: ${directory}/${name}`);
    };
    await publish(dir, 'script.js', pins.source);
    await publish(dir, 'args.json', JSON.stringify(pins.args));
    await publish(dir, 'agents.json', JSON.stringify(pins.agents));
    const inputs: Record<string, string> = Object.create(null);
    for (const [index, [name, bytes]] of Object.entries(pins.inputs).entries()) {
      const file = `${index}.input`;
      await publish(join(dir, 'inputs'), file, Buffer.from(bytes, 'base64'));
      inputs[name] = join(dir, 'inputs', file);
    }
    await publish(dir, 'inputs.json', JSON.stringify(inputs));
    const journal = await openJournal(journalPath(this.ledgers.home, wid));
    const wf: Workflow = { wid, origin: intent.origin as string, cwd: intent.cwd as string, journal, pins, scriptPath: join(dir, 'script.js'), inputs };
    this.workflows.set(wid, wf);
    if (!journal.entries().length) await journal.append('wf-created', { rid: intent.rid, origin: intent.origin, cwd: intent.cwd, revision: 1 });
    if (!this.ledgers.orch.entries().some(e => e.type === JT.created && e.rid === intent.rid)) await this.ledgers.orch.append(JT.created, { rid: intent.rid, wid, origin: intent.origin });
    return wf;
  }
  /** A1: Close shared journals only after engine and executor activity retires. */
  async close(): Promise<void> { await Promise.all([...this.workflows.values()].map(w => w.journal.close())); }
}
