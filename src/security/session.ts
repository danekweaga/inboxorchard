import { hmac, timingSafeEqual } from "./crypto";

export const SESSION_COOKIE = "dmflow_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;

export async function createSession(secret: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  const expiry = now + SESSION_SECONDS;
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const payload = `v1.${expiry}.${nonce}`;
  return `${payload}.${await hmac(payload, secret)}`;
}

export async function verifySession(value: string | undefined, secret: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!value || !secret) return false;
  const [version, expiryValue, nonce, signature] = value.split(".");
  if (version !== "v1" || !expiryValue || !nonce || !signature) return false;
  const expiry = Number(expiryValue);
  if (!Number.isFinite(expiry) || expiry <= now) return false;
  const payload = `${version}.${expiryValue}.${nonce}`;
  return timingSafeEqual(signature, await hmac(payload, secret));
}

export function requestOriginAllowed(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return origin === new URL(request.url).origin;
}
