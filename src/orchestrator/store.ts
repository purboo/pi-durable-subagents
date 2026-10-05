// Private orch entries: create-intent {rid,wid,origin,cwd,name?,snapshot:{path,hash}}
// and revise-intent {rid,wid,revision,snapshot} reference staging/<rid>/snapshot.json.
// The snapshot binds the request hash and pins (or error) before admission; never embed
// input bytes in the ledger. Workflow wf-created {rid,origin,cwd,name?,revision} and
// revised {rid,revision,snapshot} commit publications; old pins remain immutable.
import { readFile, stat, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { discoverAgents, type AgentDefinition, type DiscoveryOptions } from '../compat/agents.ts';
import { parseFrontmatter } from '../compat/frontmatter.ts';
import { compileFanout } from '../compat/fanout.ts';
import { contentHash, ulid } from '../kernel/ids.ts';
import { openJournal, syncDirectory } from '../kernel/journal.ts';
import { publishFile } from '../kernel/mailbox.ts';
import { journalPath, pinnedDir } from '../paths.ts';
import { JT, type Entry, type JournalHandle, type Request, type RunBody, type ReviseBody } from '../types.ts';
import type { Ledgers } from './contract.ts';

export interface Pins {
  source: string; args: unknown; agents: AgentDefinition[]; inputs: Record<string, string>;
  inputSources?: Record<string, string>; origin?: string; usageBudget?: RunBody['usageBudget']; maxCalls?: number;
}
export interface Workflow { wid: string; revision: number; origin: string; cwd: string; journal: JournalHandle; pins: Pins; scriptPath: string; inputs: Record<string, string> }
type SnapshotRef = { path: string; hash: string };
type Snapshot = { hash: string; pins?: Pins; error?: string; warnings?: string[] };

// E3: errors of the machine rather than of the request; they propagate so the next intake retries the request.
const TRANSIENT = /\b(EIO|ENOSPC|EDQUOT|EMFILE|ENFILE|ENOMEM|EAGAIN|EBUSY|EINTR|ETIMEDOUT|EROFS)\b/;
/** E3: Reading the request's own inputs: a missing or unreadable input is deterministic; resource errors are not. */
const transientInput = (error: unknown) => TRANSIENT.test(String((error as NodeJS.ErrnoException)?.code ?? ''));
/** E3: Publishing staging files (temp file, link, fsync): every system error is transient. */
const transientWrite = (error: unknown) => typeof (error as NodeJS.ErrnoException)?.code === 'string';

/** E3: Names an agent file with a diagnostic may define: its frontmatter name (with a package prefix) and file name. */
function diagnosticNames(sourcePath: string): string[] {
  const names = [basename(sourcePath, extname(sourcePath))];
  try {
    const { frontmatter: f } = parseFrontmatter(readFileSync(sourcePath, 'utf8'));
    if (f.name) names.push(f.name, ...(f.package ? [`${f.package.trim().toLowerCase()}.${f.name}`] : []));
  } catch { /* An unreadable file is named by its file name only. */ }
  return names;
}
/** E3, P11: A run references an agent when its pinned source names it as a string literal (fan-out specs compile to JSON). */
const references = (source: string, name: string) => ['"', "'", '`'].some(q => source.includes(`${q}${name}${q}`));

/** P33: Capture the selected branch before admission and exclude extension receipts. */
async function pinOrigin(origin: NonNullable<RunBody['origin']>): Promise<string> {
  const rows = (await readFile(origin.sessionFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; id?: string; parentId?: string | null; message?: { customType?: string } });
  const header = rows.find(e => e.type === 'session');
  if (!header) throw new Error('Origin session has no header');
  const byId = new Map(rows.filter(e => e.type !== 'session' && e.id).map(e => [e.id!, e]));
  let id = origin.leafId === undefined ? rows.findLast(e => e.type !== 'session' && e.id)?.id : origin.leafId;
  const branch: typeof rows = [], seen = new Set<string>();
  while (id) {
    if (seen.has(id)) throw new Error('Cyclic origin branch');
    seen.add(id);
    const entry = byId.get(id); if (!entry) throw new Error('Missing origin branch entry');
    branch.unshift(entry); id = entry.parentId;
  }
  return [header, ...branch.filter(e => ['message', 'model_change'].includes(e.type) && !e.message?.customType?.startsWith('dsa-'))].map(e => JSON.stringify(e)).join('\n') + '\n';
}

/** P11, A5, E3: Capture immutable admission inputs before publishing any workflow files. Agent diagnostics reject the
 *  run only for agents its source references; the others are appended to `warnings`. */
export async function prepareRun(body: RunBody, discovery?: DiscoveryOptions, warnings: string[] = []): Promise<Pins> {
  if (!body || typeof body.cwd !== 'string' || [body.workflow, body.source, body.tasks, body.chain, body.call].filter(x => x !== undefined).length !== 1) throw new Error('invalid-run');
  if (body.maxCalls !== undefined && (!Number.isSafeInteger(body.maxCalls) || body.maxCalls < 0)) throw new Error('invalid-maxCalls');
  if (body.usageBudget && Object.values(body.usageBudget).some(n => !Number.isFinite(n) || n < 0)) throw new Error('invalid-usageBudget');
  const source = body.source ?? (body.workflow ? await readFile(body.workflow, 'utf8') : compileFanout(body.tasks ? { tasks: body.tasks } : body.chain ? { chain: body.chain } : { tasks: [body.call!] }).source);
  const inputs: Record<string, string> = Object.create(null);
  for (const [name, file] of Object.entries(body.inputs ?? {})) inputs[name] = (await readFile(file)).toString('base64');
  const found = discoverAgents(body.cwd, discovery), blocking: string[] = [];
  for (const d of found.diagnostics) {
    const text = `${d.sourcePath}: ${d.error}`;
    if (!diagnosticNames(d.sourcePath).some(name => references(source, name))) { warnings.push(text); continue; }
    if (TRANSIENT.test(d.error)) throw Object.assign(new Error(text), { code: TRANSIENT.exec(d.error)![1] });
    blocking.push(text);
  }
  if (blocking.length) throw new Error(blocking.join('\n'));
  return { source, args: body.args ?? null, agents: found.agents, inputs, inputSources: body.inputs ?? {},
    ...(body.origin ? { origin: await pinOrigin(body.origin) } : {}),
    ...(body.usageBudget ? { usageBudget: body.usageBudget } : {}), ...(body.maxCalls !== undefined ? { maxCalls: body.maxCalls } : {}) };
}

/** A1, A5: Reduce only the current revision, retaining all history for seals and allocation. */
export function revisionEntries(wf: Workflow): readonly Entry[] {
  const entries = wf.journal.entries(), start = entries.findLastIndex(e => e.type === 'revised');
  return entries.slice(Math.max(0, start));
}

/** A1, A5: A resume supersedes a terminal observation without deleting history. */
export function terminalEntry(entries: readonly Entry[]): Entry | undefined {
  const last = entries.findLast(e => e.type === JT.done || (e.type === 'resumed' && !e.call) || e.type === 'revised');
  return last?.type === JT.done ? last : undefined;
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
  /** P11, P14: Pin both run and revision inputs before admission, including failures. */
  async stage(req: Request<RunBody | ReviseBody>, discovery?: DiscoveryOptions): Promise<void> {
    const dir = this.stagePath(req.rid);
    let exists = true;
    try { await stat(join(dir, 'snapshot.json')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false; }
    if (!exists) {
      let snapshot: Snapshot;
      const warnings: string[] = [];
      try {
        let body: RunBody;
        if (req.kind === 'revise') {
          const change = req.body as ReviseBody, wf = this.workflows.get(change?.wid);
          if (!wf) throw new Error('unknown-workflow');
          body = { cwd: wf.cwd, ...(change.workflow !== undefined ? { workflow: change.workflow } : { source: change.source ?? wf.pins.source }),
            args: Object.hasOwn(change, 'args') ? change.args : wf.pins.args, inputs: wf.pins.inputSources,
            usageBudget: wf.pins.usageBudget, maxCalls: wf.pins.maxCalls };
          if (change.workflow !== undefined && change.source !== undefined) throw new Error('invalid-revise');
        } else body = req.body as RunBody;
        snapshot = { hash: contentHash(req), pins: await prepareRun({ ...body, maxCalls: body.maxCalls ?? this.ledgers.config.k?.spawnBudget ?? 300 }, discovery, warnings),
          ...(warnings.length ? { warnings } : {}) };
        if (req.kind === 'revise') snapshot.pins!.origin = this.workflows.get((req.body as ReviseBody).wid)?.pins.origin;
      } catch (error) {
        if (transientInput(error)) throw error;
        snapshot = { hash: contentHash(req), error: String(error) };
      }
      await publishFile(dir, 'snapshot.json', JSON.stringify(snapshot));
      await syncDirectory(join(this.ledgers.home, 'staging'));
    }
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
      if (transientWrite(error)) throw error;
      await publishFile(dir, 'failure.json', JSON.stringify({ error: String(error) }));
    }
  }
  /** P11: Resolve admission only from the durable staging snapshot. */
  async staged(req: Request<RunBody | ReviseBody>): Promise<Pins> {
    const dir = this.stagePath(req.rid);
    const failure = await readFile(join(dir, 'failure.json'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
    if (failure) throw new Error(JSON.parse(failure).error);
    const snapshot = JSON.parse(await readFile(join(dir, 'snapshot.json'), 'utf8')) as Snapshot;
    if (snapshot.hash !== contentHash(req)) throw new Error('Staging identity conflict');
    if (!snapshot.pins) throw new Error(snapshot.error ?? 'Incomplete staging');
    return snapshot.pins;
  }
  private async reference(rid: string): Promise<SnapshotRef> {
    const path = join(this.stagePath(rid), 'snapshot.json');
    return { path: relative(this.ledgers.home, path), hash: contentHash(JSON.parse(await readFile(path, 'utf8'))) };
  }
  private async pinned(intent: Entry): Promise<Pins> {
    if (intent.pins) return intent.pins as Pins; // Read compatibility with the integrated baseline.
    const ref = intent.snapshot as SnapshotRef;
    const snapshot = JSON.parse(await readFile(join(this.ledgers.home, ref.path), 'utf8')) as Snapshot;
    if (contentHash(snapshot) !== ref.hash || !snapshot.pins) throw new Error('Staged snapshot hash mismatch');
    return snapshot.pins;
  }
  /** P3, P6: Remove staging only after a durable rejection or withdrawal without a committed intent. */
  async discardStage(rid: string): Promise<void> {
    if (this.ledgers.orch.entries().some(e => (e.type === 'create-intent' || e.type === 'revise-intent') && e.rid === rid)) return;
    await rm(this.stagePath(rid), { recursive: true, force: true });
    await syncDirectory(join(this.ledgers.home, 'staging')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  /** A5: Fix the workflow identity and snapshot reference before filesystem effects. */
  async create(req: Request<RunBody>): Promise<Workflow> {
    let intent = this.ledgers.orch.entries().find(e => e.type === 'create-intent' && e.rid === req.rid);
    intent ??= await this.ledgers.orch.append('create-intent', { rid: req.rid, wid: ulid(), origin: req.from, cwd: req.body.cwd,
      ...(req.body.name !== undefined ? { name: req.body.name } : {}), snapshot: await this.reference(req.rid) });
    return this.materialize(intent);
  }
  /** P14, A5: Bind the next revision before retiring any old authority. */
  async revisionIntent(req: Request<ReviseBody>, wf: Workflow): Promise<Entry> {
    return this.ledgers.orch.entries().find(e => e.type === 'revise-intent' && e.rid === req.rid) ??
      await this.ledgers.orch.append('revise-intent', { rid: req.rid, wid: wf.wid, revision: wf.revision + 1, snapshot: await this.reference(req.rid) });
  }
  private async publishPins(wid: string, revision: number, pins: Pins) {
    const root = pinnedDir(this.ledgers.home, wid), dir = revision === 1 ? root : join(root, `r${revision}`);
    const publish = async (directory: string, name: string, bytes: string | Buffer) => {
      if (await publishFile(directory, name, bytes) === 'conflict') throw new Error(`Pinned content conflict: ${directory}/${name}`);
    };
    if (pins.origin !== undefined) await publish(dir, 'origin.jsonl', pins.origin);
    await publish(dir, 'script.js', pins.source);
    await publish(dir, 'args.json', JSON.stringify(pins.args));
    await publish(dir, 'agents.json', JSON.stringify(pins.agents));
    const inputs: Record<string, string> = Object.create(null);
    for (const [index, [name, bytes]] of Object.entries(pins.inputs).entries()) {
      const file = `${index}.input`; await publish(join(dir, 'inputs'), file, Buffer.from(bytes, 'base64'));
      inputs[name] = join(dir, 'inputs', file);
    }
    await publish(dir, 'inputs.json', JSON.stringify(inputs));
    return { pins, scriptPath: join(dir, 'script.js'), inputs };
  }
  /** P14, A2: Publish a new revision only after the engine has retired its predecessor. */
  async revise(intent: Entry): Promise<void> {
    const wf = this.workflows.get(intent.wid as string)!;
    if (wf.revision >= Number(intent.revision)) return;
    const pins = await this.pinned(intent), revision = Number(intent.revision);
    const files = await this.publishPins(wf.wid, revision, pins);
    await wf.journal.append('revised', { rid: intent.rid, revision, snapshot: intent.snapshot });
    Object.assign(wf, files, { revision });
  }
  /** P32: Rebuild a historical ticket from that revision's immutable snapshot. */
  async atRevision(wf: Workflow, revision: number): Promise<Workflow> {
    if (revision === wf.revision) return wf;
    const intent = revision === 1
      ? this.ledgers.orch.entries().find(e => e.type === 'create-intent' && e.wid === wf.wid)
      : wf.journal.entries().find(e => e.type === 'revised' && e.revision === revision);
    if (!intent) throw new Error(`Missing pinned revision: ${wf.wid}@${revision}`);
    const pins = await this.pinned(intent);
    return { ...wf, revision, ...await this.publishPins(wf.wid, revision, pins) };
  }
  /** A1, A5: Restore committed revisions; the engine reconciles pending retirement intents. */
  async recover(): Promise<void> {
    for (const intent of this.ledgers.orch.entries().filter(e => e.type === 'create-intent')) await this.materialize(intent);
  }
  private async materialize(intent: Entry): Promise<Workflow> {
    const wid = intent.wid as string, existing = this.workflows.get(wid);
    if (existing) return existing;
    const pins = await this.pinned(intent), files = await this.publishPins(wid, 1, pins);
    const journal = await openJournal(journalPath(this.ledgers.home, wid));
    const wf: Workflow = { wid, revision: 1, origin: intent.origin as string, cwd: intent.cwd as string, journal, ...files };
    this.workflows.set(wid, wf);
    if (!journal.entries().length) await journal.append('wf-created', { rid: intent.rid, origin: intent.origin, cwd: intent.cwd, revision: 1,
      ...(intent.name !== undefined ? { name: intent.name } : {}) });
    const revised = journal.entries().findLast(e => e.type === 'revised');
    if (revised) Object.assign(wf, await this.publishPins(wid, Number(revised.revision), await this.pinned(revised)), { revision: Number(revised.revision) });
    if (!this.ledgers.orch.entries().some(e => e.type === JT.created && e.rid === intent.rid)) await this.ledgers.orch.append(JT.created, { rid: intent.rid, wid, origin: intent.origin });
    return wf;
  }
  /** A1: Close shared journals only after engine and executor activity retires. */
  async close(): Promise<void> { await Promise.all([...this.workflows.values()].map(w => w.journal.close())); }
}
