import { id, unixNow } from "../core/id";
import { kvGet, kvSet } from "../db";
import { sealSecret } from "../security/crypto";
import { openSecret } from "../security/crypto";
import type { Env } from "../types";
import { html } from "../routes/http";

type GooglePurpose = "gmail" | "sheets";

interface GoogleState {
  expiresAt: number;
  purpose: GooglePurpose;
  spreadsheetId?: string;
  range?: string;
  usedAt?: number;
}

interface GoogleTokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error_description?: string;
}

export async function createGoogleAuthorizeUrl(
  env: Env,
  input: { purpose: GooglePurpose; spreadsheetId?: string; range?: string },
): Promise<string> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
    throw new Error("Google OAuth credentials and GOOGLE_REDIRECT_URI are required");
  }
  if (input.purpose === "sheets" && (!input.spreadsheetId || !/^[a-zA-Z0-9-_]+$/.test(input.spreadsheetId))) {
    throw new Error("A valid spreadsheet ID is required");
  }
  const state = crypto.randomUUID().replaceAll("-", "");
  const record: GoogleState = {
    expiresAt: unixNow() + 600,
    purpose: input.purpose,
    spreadsheetId: input.spreadsheetId,
    range: input.range,
  };
  await kvSet(env.DB, `google_oauth_state:${state}`, JSON.stringify(record));
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.GOOGLE_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  const scopes = ["openid", "email", "profile", input.purpose === "gmail"
    ? "https://www.googleapis.com/auth/gmail.send"
    : "https://www.googleapis.com/auth/spreadsheets"];
  url.searchParams.set("scope", scopes.join(" "));
  return url.toString();
}

export async function handleGoogleCallback(env: Env, url: URL): Promise<Response> {
  const stateValue = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const providerError = url.searchParams.get("error");
  if (providerError) return html(`<h1>Google connection cancelled</h1><p>${escapeHtml(providerError)}</p>`, 400);
  if (!stateValue || !code) return html("<h1>Missing Google authorization response</h1>", 400);
  const state = parseState(await kvGet(env.DB, `google_oauth_state:${stateValue}`));
  if (!state || state.expiresAt < unixNow() || state.usedAt) return html("<h1>Invalid or expired Google OAuth state</h1>", 400);
  await kvSet(env.DB, `google_oauth_state:${stateValue}`, JSON.stringify({ ...state, usedAt: unixNow() }));
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI || !env.ENCRYPTION_KEY) {
    return html("<h1>Google OAuth is not fully configured</h1>", 503);
  }
  try {
    const tokens = await exchangeCode(env, code);
    if (!tokens.access_token) throw new Error(tokens.error_description ?? "Google did not return an access token");
    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await profileResponse.json() as { email?: string; name?: string; sub?: string; error?: string };
    if (!profileResponse.ok || !profile.email) throw new Error(profile.error ?? "Google profile lookup failed");
    const timestamp = unixNow();
    const credentials = await sealSecret(JSON.stringify({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: timestamp + (tokens.expires_in ?? 3600),
      scope: tokens.scope,
    }), env.ENCRYPTION_KEY);
    if (state.purpose === "gmail") {
      await env.DB.prepare(
        `INSERT INTO email_senders
          (id, provider, email, display_name, purpose, status, credentials_ciphertext, safety_limit, created_at, updated_at)
         VALUES (?, 'gmail', ?, ?, 'Creator email follow-up', 'connected', ?, 450, ?, ?)`,
      ).bind(id("sender"), profile.email, profile.name ?? null, credentials, timestamp, timestamp).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO integration_connections
          (id, provider, label, status, credentials_ciphertext, config_json, created_at, updated_at)
         VALUES (?, 'google_sheets', ?, 'connected', ?, ?, ?, ?)`,
      ).bind(
        id("int"), `Google Sheets · ${profile.email}`, credentials,
        JSON.stringify({ spreadsheetId: state.spreadsheetId, range: state.range ?? "Sheet1!A:Z", accountEmail: profile.email }),
        timestamp, timestamp,
      ).run();
    }
    return html(`<h1>Google connected ✅</h1><p>${escapeHtml(profile.email)} is ready for ${state.purpose === "gmail" ? "Gmail delivery" : "Google Sheets actions"}. You can close this tab.</p>`);
  } catch (error) {
    return html(`<h1>Google connection failed</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`, 500);
  }
}

export async function refreshGoogleToken(env: Env, refreshToken: string): Promise<{ accessToken: string; expiresAt: number }> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error("Google OAuth credentials are not configured");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const body = await response.json() as GoogleTokens;
  if (!response.ok || !body.access_token) throw new Error(body.error_description ?? `Google token refresh failed (${response.status})`);
  return { accessToken: body.access_token, expiresAt: unixNow() + (body.expires_in ?? 3600) };
}

export async function activeGoogleAccessToken(
  env: Env,
  ciphertext: string,
  saveCiphertext: (value: string) => Promise<void>,
): Promise<string> {
  const stored = JSON.parse(await openSecret(ciphertext, env.ENCRYPTION_KEY ?? "")) as {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scope?: string;
  };
  if (stored.accessToken && (stored.expiresAt ?? 0) > unixNow() + 90) return stored.accessToken;
  if (!stored.refreshToken) throw new Error("Google access expired and no refresh token is available; reconnect the integration");
  const refreshed = await refreshGoogleToken(env, stored.refreshToken);
  const next = { ...stored, ...refreshed };
  await saveCiphertext(await sealSecret(JSON.stringify(next), env.ENCRYPTION_KEY ?? ""));
  return refreshed.accessToken;
}

async function exchangeCode(env: Env, code: string): Promise<GoogleTokens> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: env.GOOGLE_REDIRECT_URI!, grant_type: "authorization_code" }),
  });
  const body = await response.json() as GoogleTokens;
  if (!response.ok) throw new Error(body.error_description ?? `Google token exchange failed (${response.status})`);
  return body;
}

function parseState(value: string | null): GoogleState | null {
  if (!value) return null;
  try {
    const state = JSON.parse(value) as Partial<GoogleState>;
    if (typeof state.expiresAt !== "number" || (state.purpose !== "gmail" && state.purpose !== "sheets")) return null;
    return state as GoogleState;
  } catch { return null; }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
