import { id, unixNow } from "../core/id";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "text/plain",
  "application/zip",
]);

export interface ResourceRecord {
  id: string;
  name: string;
  description: string | null;
  type: "link" | "file" | "image" | "pdf" | "text";
  target_url: string | null;
  r2_key: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  active: number;
  created_at: number;
  updated_at: number;
}

export async function createLinkResource(db: D1Database, input: { name: string; description?: string; url: string }): Promise<ResourceRecord> {
  const url = new URL(input.url);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Resource URL must use HTTP or HTTPS");
  const resourceId = id("res");
  const timestamp = unixNow();
  await db.prepare(
    `INSERT INTO resources (id, name, description, type, target_url, active, created_at, updated_at)
     VALUES (?, ?, ?, 'link', ?, 1, ?, ?)`,
  ).bind(resourceId, input.name.trim(), input.description?.trim() ?? null, url.toString(), timestamp, timestamp).run();
  const row = await db.prepare("SELECT * FROM resources WHERE id = ?").bind(resourceId).first<ResourceRecord>();
  if (!row) throw new Error("Resource creation failed");
  return row;
}

export async function uploadResource(
  db: D1Database,
  bucket: R2Bucket | undefined,
  input: { name: string; description?: string; file: File },
): Promise<ResourceRecord> {
  if (!bucket) throw new Error("R2 storage is not configured");
  if (input.file.size <= 0 || input.file.size > MAX_UPLOAD_BYTES) throw new Error("Files must be between 1 byte and 25 MB");
  if (!ALLOWED_MIME.has(input.file.type)) throw new Error(`Unsupported file type: ${input.file.type || "unknown"}`);
  const resourceId = id("res");
  const safeName = input.file.name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-140) || "resource";
  const key = `resources/${resourceId}/${safeName}`;
  await bucket.put(key, input.file.stream(), {
    httpMetadata: { contentType: input.file.type, contentDisposition: `attachment; filename="${safeName}"` },
    customMetadata: { resourceId },
  });
  const type = input.file.type === "application/pdf" ? "pdf" : input.file.type.startsWith("image/") ? "image" : "file";
  const timestamp = unixNow();
  try {
    await db.prepare(
      `INSERT INTO resources
        (id, name, description, type, r2_key, file_name, mime_type, size_bytes, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(resourceId, input.name.trim(), input.description?.trim() ?? null, type, key, safeName, input.file.type, input.file.size, timestamp, timestamp).run();
  } catch (error) {
    await bucket.delete(key);
    throw error;
  }
  const row = await db.prepare("SELECT * FROM resources WHERE id = ?").bind(resourceId).first<ResourceRecord>();
  if (!row) throw new Error("Resource upload metadata failed");
  return row;
}
