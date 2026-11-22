import { z } from "zod";
import type { Env } from "./types";

const config = z.array(z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  label: z.string().trim().min(1),
  instagramId: z.string().regex(/^\d+$/),
  origin: z.string().url().refine(value => value.startsWith("https://") && new URL(value).origin === value),
}));

export function workspaces(env: Env): { key?: string; origins: string[]; resolve: () => Env }[] {
  if (!env.WORKSPACES) return [{ origins: [], resolve: () => env }];
  const entries = config.parse(JSON.parse(env.WORKSPACES));
  const mainOrigin = new URL(env.PUBLIC_APP_ORIGIN || env.PUBLIC_BASE_URL!).origin;
  const options = [{ label: "Main account", origin: mainOrigin }, ...entries.map(({ label, origin }) => ({ label, origin }))];
  if (new Set(options.map(option => option.origin)).size !== options.length ||
      new Set(entries.map(entry => entry.key)).size !== entries.length ||
      entries.some(entry => entry.origin === new URL(env.PUBLIC_BASE_URL!).origin)) throw new Error("Duplicate workspace configuration");
  const bindings = env as unknown as Record<string, unknown>;
  return [{ origins: [mainOrigin, new URL(env.PUBLIC_BASE_URL!).origin], resolve: () => ({ ...env, workspaceOptions: options }) }, ...entries.map(({ key, origin, instagramId }) => ({ key, origins: [origin], resolve: () => {
    const db = bindings[key + "_DB"] as D1Database;
    function secret(suffix: string) {
      const value = bindings[key + suffix];
      if (typeof value !== "string" || !value) throw new Error("Missing workspace secret for " + key + suffix);
      return value;
    }
    if (!db?.prepare || db === env.DB) throw new Error("Missing separate database for " + key);
    return { ...env, DB: db, workspaceKey: key, workspaceOptions: options, workspaceInstagramId: instagramId,
      RESOURCES: bindings[key + "_RESOURCES"] as R2Bucket | undefined,
      META_APP_ID: secret("_META_APP_ID"), META_APP_SECRET: secret("_META_APP_SECRET"),
      META_VERIFY_TOKEN: secret("_META_VERIFY_TOKEN"), ENCRYPTION_KEY: secret("_ENCRYPTION_KEY"),
      BREVO_API_KEY: undefined, RESEND_API_KEY: undefined,
      PUBLIC_BASE_URL: origin, PUBLIC_APP_ORIGIN: origin, REDIRECT_URI: origin + "/auth/callback",
      GOOGLE_REDIRECT_URI: origin + "/auth/google/callback" };
  } }))];
}
