import { describe, expect, it } from "vitest";
import { verifySignature } from "../src/routes/webhook";

async function signature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("Meta webhook signatures", () => {
  it("accepts the exact signed raw payload", async () => {
    const body = JSON.stringify({ entry: [{ id: "event" }] });
    expect(await verifySignature("app-secret", body, await signature("app-secret", body))).toBe(true);
  });

  it("rejects tampered payloads and missing signatures", async () => {
    const signed = await signature("app-secret", "original");
    expect(await verifySignature("app-secret", "tampered", signed)).toBe(false);
    expect(await verifySignature("app-secret", "original", null)).toBe(false);
  });
});
