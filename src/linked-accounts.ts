import { accountDatabase } from "./account-storage";
import { kvGet } from "./db";
import type { Env } from "./types";

export const accountPrefix = "ig-account:";
export function linkedEnv(env: Env, id: string): Env {
  if (!env.IG_ACCOUNTS || !/^\d+$/.test(id)) throw new Error("Invalid Instagram workspace");
  const base = (env.PUBLIC_BASE_URL || new URL(env.REDIRECT_URI).origin) + "/api/account/" + id;
  return { ...env, registryDB: env.DB, DB: accountDatabase(env.IG_ACCOUNTS, id),
    workspaceKey: accountPrefix + id, workspaceInstagramId: id, PUBLIC_BASE_URL: base,
    GOOGLE_REDIRECT_URI: base + "/auth/google/callback", BREVO_API_KEY: undefined, RESEND_API_KEY: undefined };
}
export async function linkedAccounts(env: Env) {
  if (!env.IG_ACCOUNTS) return [];
  const rows = await (env.registryDB ?? env.DB).prepare("SELECT key,value FROM kv WHERE key LIKE 'ig-account:%' ORDER BY key").all<{key:string;value:string}>();
  return rows.results.map(row => ({ id: row.key.slice(accountPrefix.length), username: row.value }));
}
export function registered(env: Env, id: string) { return kvGet(env.registryDB ?? env.DB, accountPrefix + id); }
