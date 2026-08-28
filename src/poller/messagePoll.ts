// Message poll (Section 5A). Reads recent conversations and feeds inbound messages (taps,
// email replies) to the engine. This is how quick-reply taps / typed replies are received
// without webhooks. Idempotency is enforced in the engine via each conversation's updated_at,
// so re-reading the same message history is safe.

import { kvGet, kvSet, now } from "../db";
import type { Runtime } from "../runtime";
import { toUnixSeconds } from "../runtime";
import type { NormalizedMessage } from "../types";

const CURSOR_KEY = "last_msg_poll_ts";
const OVERLAP_SECONDS = 120; // small look-back so nothing is missed between ticks

export async function pollMessages(rt: Runtime, db: D1Database): Promise<void> {
  const cursorRaw = await kvGet(db, CURSOR_KEY);
  const cursor = cursorRaw ? Number(cursorRaw) : 0;
  const floor = cursor > 0 ? cursor - OVERLAP_SECONDS : 0;

  let conversations;
  try {
    conversations = await rt.client.getConversations();
  } catch (e) {
    console.warn(`[inbox-orchard] getConversations failed: ${e instanceof Error ? e.message : e}`);
    return;
  }

  let maxTs = cursor;
  for (const convo of conversations) {
    for (const m of convo.messages?.data ?? []) {
      const fromId = m.from?.id;
      if (!fromId || fromId === rt.igUserId) continue; // skip our own outbound messages
      const ts = toUnixSeconds(m.created_time);
      if (ts < floor) continue;
      if (ts > maxTs) maxTs = ts;

      const evt: NormalizedMessage = {
        kind: "message",
        igsid: fromId,
        text: m.message,
        timestamp: ts,
        // Polling does not expose the hidden quick-reply payload; the engine resolves taps by
        // matching text to the expected button title for the conversation's state.
      };
      await rt.engine.handleMessage(evt);
    }
  }

  await kvSet(db, CURSOR_KEY, String(Math.max(maxTs, now() - OVERLAP_SECONDS)));
}
