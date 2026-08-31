import type { IgMedia } from "../api/client";
import { unixNow } from "../core/id";
import { buildRuntime } from "../runtime";
import type { Env } from "../types";

export async function refreshInstagramMedia(env: Env, limit = 100): Promise<IgMedia[]> {
  const runtime = await buildRuntime(env);
  if (!runtime) throw new Error("Instagram is not connected or its access token has expired");
  const media = await runtime.client.getMedia(limit);
  await storeInstagramMedia(env.DB, media);
  return media;
}

export async function storeInstagramMedia(db: D1Database, media: IgMedia[]): Promise<void> {
  if (!media.length) return;
  const syncedAt = unixNow();
  await db.batch(media.map((item) => {
    const parsedTimestamp = item.timestamp ? Date.parse(item.timestamp) : Number.NaN;
    const publishedAt = Number.isNaN(parsedTimestamp) ? null : Math.floor(parsedTimestamp / 1000);
    const mediaType = item.media_product_type === "REELS" ? "REEL" : item.media_type ?? "UNKNOWN";
    return db.prepare(
      `INSERT INTO instagram_media
        (id, media_type, caption, permalink, thumbnail_url, media_url, comments_count, published_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         media_type = excluded.media_type,
         caption = COALESCE(excluded.caption, instagram_media.caption),
         permalink = COALESCE(excluded.permalink, instagram_media.permalink),
         thumbnail_url = COALESCE(excluded.thumbnail_url, instagram_media.thumbnail_url),
         media_url = COALESCE(excluded.media_url, instagram_media.media_url),
         comments_count = COALESCE(excluded.comments_count, instagram_media.comments_count),
         published_at = COALESCE(excluded.published_at, instagram_media.published_at),
         synced_at = excluded.synced_at`,
    ).bind(
      item.id,
      mediaType,
      item.caption ?? null,
      item.permalink ?? null,
      item.thumbnail_url ?? null,
      item.media_url ?? null,
      item.comments_count ?? null,
      publishedAt,
      syncedAt,
    );
  }));
}
