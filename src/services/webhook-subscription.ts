import { kvGet, kvSet, now } from "../db";
import { buildRuntime } from "../runtime";
import type { Env } from "../types";

const CHECK_INTERVAL_SECONDS = 86400;
const CHECK_KEY = "instagram_webhook_subscription_checked_at";

/**
 * Existing installations can predate account-level webhook subscription. Re-applying the
 * subscription is idempotent, so check it daily and self-heal without forcing a new OAuth login.
 */
export async function ensureInstagramWebhookSubscription(env: Env): Promise<"subscribed" | "current" | "no_auth" | "failed"> {
  const checkedAt = Number(await kvGet(env.DB, CHECK_KEY)) || 0;
  if (checkedAt > now() - CHECK_INTERVAL_SECONDS) return "current";

  const runtime = await buildRuntime(env);
  if (!runtime) return "no_auth";

  try {
    const result = await runtime.client.subscribeWebhooks();
    if (!result.success) throw new Error("Meta returned success=false");
    await kvSet(env.DB, CHECK_KEY, String(now()));
    console.log("[inbox-orchard] Instagram account webhook subscription verified");
    return "subscribed";
  } catch (error) {
    console.warn(`[inbox-orchard] Instagram webhook subscription repair failed: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}
