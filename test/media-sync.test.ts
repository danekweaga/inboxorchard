import { beforeEach, describe, expect, it } from "vitest";
import { storeInstagramMedia } from "../src/services/media-sync";
import { makeTestDb } from "./helpers/fakeD1";

describe("Instagram media sync", () => {
  let db: D1Database;

  beforeEach(() => { db = makeTestDb(); });

  it("enriches an unknown webhook media row with the live Reel metadata", async () => {
    await db.prepare(
      "INSERT INTO instagram_media (id, media_type, published_at, synced_at) VALUES (?, 'UNKNOWN', ?, ?)",
    ).bind("media_1", 1_700_000_000, 1_700_000_000).run();

    await storeInstagramMedia(db, [{
      id: "media_1",
      caption: "A Reel about building in public",
      media_type: "VIDEO",
      media_product_type: "REELS",
      thumbnail_url: "https://cdn.example.com/reel.jpg",
      media_url: "https://cdn.example.com/reel.mp4",
      permalink: "https://www.instagram.com/reel/example/",
      timestamp: "2026-08-30T12:00:00+0000",
      comments_count: 42,
    }]);

    const row = await db.prepare("SELECT * FROM instagram_media WHERE id = ?").bind("media_1").first<Record<string, unknown>>();
    expect(row).toMatchObject({
      media_type: "REEL",
      caption: "A Reel about building in public",
      thumbnail_url: "https://cdn.example.com/reel.jpg",
      permalink: "https://www.instagram.com/reel/example/",
      comments_count: 42,
    });
  });
});
