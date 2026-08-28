// OAuth onboarding routes (Section 4A). "Connect Instagram" → authorize redirect → callback
// code exchange → long-lived token stored in auth. Plus connection status + disconnect.

import { buildAuthorizeUrl, exchangeCodeForShortLivedToken, exchangeForLongLivedToken } from "../auth/oauth";
import { InstagramClient } from "../api/client";
import { sha256, unixNow } from "../core/id";
import { clearAuth, getAuth, kvGet, kvSet, now, saveAuth } from "../db";
import type { Env } from "../types";
import { metaAppId, metaAppSecret } from "../types";
import { json, redirect, html } from "./http";

function randomState(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** GET /auth/authorize — start the OAuth flow. */
export async function handleAuthorize(env: Env, url: URL): Promise<Response> {
  const appId = metaAppId(env);
  const appSecret = metaAppSecret(env);
  if (!appId || !appSecret) {
    return json({ error: "META_APP_ID/META_APP_SECRET not configured" }, 500);
  }
  const ticket = url.searchParams.get("ticket");
  if (!ticket) return html("<h1>Connection link is missing or expired</h1><p>Start the connection from the owner dashboard.</p>", 401);
  const ticketKey = `oauth_ticket:${await sha256(ticket)}`;
  const ticketRecord = parseExpiringValue(await kvGet(env.DB, ticketKey));
  if (!ticketRecord || ticketRecord.expiresAt < unixNow() || ticketRecord.usedAt) {
    return html("<h1>Connection link is missing or expired</h1><p>Return to the owner dashboard and try again.</p>", 401);
  }
  await kvSet(env.DB, ticketKey, JSON.stringify({ ...ticketRecord, usedAt: unixNow() }));
  const state = randomState();
  await kvSet(env.DB, `oauth_state:${state}`, JSON.stringify({ expiresAt: unixNow() + 600 }));
  return redirect(buildAuthorizeUrl(appId, env.REDIRECT_URI, state));
}

/** GET /auth/callback — exchange the code, verify the account is professional, store the token. */
export async function handleCallback(env: Env, url: URL): Promise<Response> {
  const error = url.searchParams.get("error");
  if (error) {
    return html(`<h1>Connection cancelled</h1><p>${escapeHtml(error)}</p>`, 400);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return html("<h1>Missing authorization code</h1>", 400);

  const expected = state ? parseExpiringValue(await kvGet(env.DB, `oauth_state:${state}`)) : null;
  if (!state || !expected || expected.expiresAt < unixNow() || expected.usedAt) return html("<h1>Invalid state (possible CSRF)</h1>", 400);
  await kvSet(env.DB, `oauth_state:${state}`, JSON.stringify({ ...expected, usedAt: unixNow() }));

  try {
    const appId = metaAppId(env);
    const appSecret = metaAppSecret(env);
    const short = await exchangeCodeForShortLivedToken(appId, appSecret, env.REDIRECT_URI, code);
    // Diagnostic: Meta can silently grant fewer scopes than requested (e.g. a permission not yet
    // enabled for this app in the dashboard). Log what was actually granted vs. requested so a
    // "why can't I read comments" report can be root-caused without guessing.
    console.log(`[inbox-orchard] OAuth granted permissions: ${JSON.stringify(short.permissions ?? "none reported")}`);
    const long = await exchangeForLongLivedToken(env.GRAPH_VERSION, appSecret, short.accessToken);

    // Fetch the profile to enforce the professional-account requirement + power the UI preview.
    const client = new InstagramClient(long.accessToken, env.GRAPH_VERSION, "me");
    const me = await client.getMe();
    const accountType = (me.account_type ?? "").toUpperCase();
    if (accountType === "PERSONAL") {
      return html(
        `<h1>Personal accounts aren't supported</h1>
         <p>Inbox Orchard needs an Instagram <b>Professional</b> (Creator or Business) account.</p>
         <p>In the Instagram app: <b>Settings → Account type and tools → Switch to professional account</b>, then reconnect.</p>`,
        400,
      );
    }

    await saveAuth(env.DB, {
      access_token: long.accessToken,
      expires_at: now() + long.expiresIn,
      ig_user_id: me.user_id ?? short.userId,
      username: me.username ?? null,
      account_type: me.account_type ?? null,
      profile_picture_url: me.profile_picture_url ?? null,
    }, env.ENCRYPTION_KEY);

    return html(
      `<h1>Connected ✅</h1>
       <p>@${escapeHtml(me.username ?? "your account")} is now connected to Inbox Orchard.</p>
       <p>Token valid ~60 days; it auto-refreshes. You can close this tab.</p>`,
    );
  } catch (e) {
    return html(`<h1>Connection failed</h1><pre>${escapeHtml(e instanceof Error ? e.message : String(e))}</pre>`, 500);
  }
}

/** GET /auth/status — connection status (owner-only). */
export async function handleStatus(env: Env): Promise<Response> {
  const auth = await getAuth(env.DB, env.ENCRYPTION_KEY);
  if (!auth) return json({ connected: false });
  return json({
    connected: true,
    username: auth.username,
    account_type: auth.account_type,
    profile_picture_url: auth.profile_picture_url,
    ig_user_id: auth.ig_user_id,
    expires_at: auth.expires_at,
    expires_in_days: Math.max(0, Math.round((auth.expires_at - now()) / 86400)),
  });
}

/** POST /auth/disconnect — clear the token (owner-only). */
export async function handleDisconnect(env: Env): Promise<Response> {
  await clearAuth(env.DB);
  return json({ disconnected: true });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function parseExpiringValue(value: string | null): { expiresAt: number; usedAt?: number } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { expiresAt?: unknown; usedAt?: unknown };
    if (typeof parsed.expiresAt !== "number") return null;
    return { expiresAt: parsed.expiresAt, usedAt: typeof parsed.usedAt === "number" ? parsed.usedAt : undefined };
  } catch {
    return null;
  }
}
