import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { publishRequest } from '../../../src/kernel/mailbox.ts';

/** C6: Publish after the child's turn_end intake to exercise its final settle boundary. */
export default function boundaryProbe(pi: ExtensionAPI): void {
  let sent = false;
  pi.on('turn_end', async () => {
    if (sent) return;
    sent = true;
    await publishRequest(process.env.DSA_INBOX!, { rid: 'r2', from: 'orch', to: 'call', sseq: 2, kind: 'steer', body: { message: '#script: [{"text":"settle boundary"}]' } });
  });
}
