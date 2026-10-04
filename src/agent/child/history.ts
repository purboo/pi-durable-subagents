import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { CT } from '../../types.ts';
import type { DecisionRecord } from '../../kernel/lifecycle.ts';

export interface Question { qid: string; rev: number; question: string }
/** A1, P4, P8, P37: Recover receipts and question revisions for this call generation. A generation continues the
 *  session of the previous one (P37), but request sequences are per recipient (P5): records addressed to an earlier
 *  generation stay in history and are skipped here: segments opened by another call's execution marker are foreign. */
export function recover(entries: readonly SessionEntry[], call?: string) {
  const records: DecisionRecord[] = [], questions = new Map<string, Question>(), answered = new Set<string>();
  let foreign = false;
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === CT.exec) {
      const owner = /^(.*)#\d+\.\d+$/.exec(String((entry.data as { exec?: string } | undefined)?.exec ?? ''));
      foreign = call !== undefined && !!owner && owner[1] !== call;
    }
    if (foreign) continue;
    if (entry.type === 'custom') {
      const data = entry.data as Record<string, any>;
      if (!data) continue;
      if (entry.customType === CT.admitted) records.push({ ...data, type: 'admitted' } as DecisionRecord);
      if (entry.customType === CT.rejected) records.push({ type: 'rejected', rid: data.rid, reason: data.reason });
      if (entry.customType === CT.withdrawn) {
        records.push({ type: 'withdrawn', rids: data.rids });
        if (data.rid) records.push({ type: 'applied', rid: data.rid });
      }
      if (entry.customType === CT.model) records.push({ type: 'applied', rid: data.rid });
      if (entry.customType === CT.question) questions.set(data.qid, data as unknown as Question);
    } else if (entry.type === 'custom_message' && entry.customType === CT.msg) {
      const details = entry.details as { rid: string; qid?: string; rev?: number };
      records.push({ type: 'applied', rid: details.rid });
      // P28: a hibernation resume delivers the answer as a continue message; its receipt answers qid@rev.
      if (details.qid && details.rev) answered.add(`${details.qid}@${details.rev}`);
    } else if (entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === 'ask') {
      const details = entry.message.details as { rid?: string; qid?: string; rev?: number } | undefined;
      if (details?.rid) records.push({ type: 'applied', rid: details.rid });
      if (details?.qid && details.rev) answered.add(`${details.qid}@${details.rev}`);
    }
  }
  return { records, questions, answered };
}
