// Shared types for Inbox Orchard.

/** Cloudflare bindings + vars available on the Worker environment. */
export interface Env {
  DB: D1Database;
  /** Optional in tests; required in a deployed installation. */
  TASK_QUEUE?: Queue;
  RESOURCES?: R2Bucket;
  AI?: Ai;

  // vars (wrangler.toml [vars])
  GRAPH_VERSION: string;
  MODE: "polling" | "webhook";
  POLL_INTERVAL_SECONDS: string;
  REDIRECT_URI: string;
  FREE_MODE?: string;
  MOCK_MODE?: string;
  AI_MODEL?: string;
  PUBLIC_BASE_URL?: string;
  PUBLIC_APP_ORIGIN?: string;

  // secrets (wrangler secret put ...)
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_VERIFY_TOKEN?: string;
  OWNER_TOKEN: string;
  SESSION_SECRET?: string;
  ENCRYPTION_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  BREVO_API_KEY?: string;

  /** Backwards-compatible secret names from chatmany 0.1. */
  APP_ID?: string;
  APP_SECRET?: string;
  WEBHOOK_VERIFY_TOKEN?: string;
}

export function metaAppId(env: Env): string {
  return env.META_APP_ID ?? env.APP_ID ?? "";
}

export function metaAppSecret(env: Env): string {
  return env.META_APP_SECRET ?? env.APP_SECRET ?? "";
}

export function metaVerifyToken(env: Env): string {
  return env.META_VERIFY_TOKEN ?? env.WEBHOOK_VERIFY_TOKEN ?? "";
}

export function isMockMode(env: Env): boolean {
  return env.MOCK_MODE === "true";
}

export function isFreeMode(env: Env): boolean {
  return env.FREE_MODE !== "false";
}

/** Funnel state for one person in one campaign. */
export type State =
  | "NEW"
  | "AWAITING_TAP"
  | "AWAITING_FOLLOW"
  | "AWAITING_EMAIL"
  | "DELIVER"
  | "DONE";

/** Analytics event types (mirrors events.type). */
export type EventType =
  | "comment_matched"
  | "opening_sent"
  | "button_clicked"
  | "follow_confirmed"
  | "email_captured"
  | "delivered";

export interface RewardConfig {
  type: "link" | "code" | "text";
  value: string;
}

export interface PublicReplyConfig {
  enabled: boolean;
  texts: string[];
}

export interface CampaignCopy {
  opening: string;
  opening_button?: string;
  follow_gate?: string;
  follow_button?: string;
  email_ask?: string;
  delivery: string;
}

/** A single campaign (Section 7). Validated on load. */
export interface Campaign {
  campaign_id: string;
  /** Human-friendly automation name shown in the builder/list (optional). */
  name?: string;
  media_id: string;
  keywords: string[];
  exclude?: string[];
  public_reply?: PublicReplyConfig;
  /** @deprecated Instagram's API cannot like comments. Accepted for backwards compatibility; ignored. */
  like_comment?: boolean;
  check_follow?: boolean;
  verify_follow_count?: boolean;
  ask_email?: boolean;
  reward: RewardConfig;
  copy: CampaignCopy;
}

/** Top-level config file / import payload (Section 7). */
export interface AppConfig {
  mode?: "polling" | "webhook";
  poll_interval_seconds?: number;
  campaigns: Campaign[];
}

/** Normalized event the engine consumes, regardless of transport (poll or webhook). */
export interface NormalizedComment {
  kind: "comment";
  comment_id: string;
  igsid: string;
  username?: string;
  text: string;
  media_id: string;
  timestamp: number;
}

export interface NormalizedMessage {
  kind: "message";
  igsid: string;
  message_id?: string;
  text?: string;
  /** Postback / quick-reply payload if the transport exposes it (webhooks do; polling may not). */
  payload?: string;
  /** Email captured from a user_email quick-reply chip, if present. */
  email?: string;
  event_type?: "message" | "story_reply" | "story_mention" | "postback" | "reaction" | "seen";
  raw?: unknown;
  timestamp: number;
}

export type NormalizedEvent = NormalizedComment | NormalizedMessage;

/** Stored auth row. */
export interface AuthRow {
  access_token: string;
  ig_user_id: string | null;
  username: string | null;
  account_type: string | null;
  profile_picture_url: string | null;
  expires_at: number;
  refreshed_at: number | null;
}
