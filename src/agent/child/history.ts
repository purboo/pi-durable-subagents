import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { CT } from '../../types.ts';
import type { DecisionRecord } from '../../kernel/lifecycle.ts';

export interface Question { qid: string; rev: number; question: string }
/** A1, P4, P8: Recover receipts and question revisions from the complete session history. */
export function recover(entries: readonly SessionEntry[]) {
  const records: DecisionRecord[] = [], questions = new Map<string, Question>(), answered = new Set<string>();
  for (const entry of entries) {
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
