import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const options = { modules: true, scriptPath: "dist/chatmany/index.js",
  compatibilityDate: "2026-08-26", compatibilityFlags: ["nodejs_compat"],
  d1Databases: ["DB"], durableObjects: { IG_ACCOUNTS: { className: "InstagramAccountStorage", useSQLite: true } },
  bindings: { META_APP_SECRET: "local-test-secret", REDIRECT_URI: "https://demo.test/auth/callback" } };
const mf = new Miniflare(convertV4MiniflareOptions(options));
try {
  const main = await mf.getD1Database("DB");
  await main.prepare("CREATE TABLE auth(id INTEGER,ig_user_id TEXT)").run();
  await main.prepare("INSERT INTO auth VALUES(1,'111')").run();
  await main.prepare("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT)").run();
  await main.prepare("INSERT INTO kv VALUES('ig-account:222','second')").run();
  const ns = await mf.getDurableObjectNamespace("IG_ACCOUNTS");
  const count = async id => {
    const response = await ns.get(ns.idFromName(id)).fetch("https://storage.internal/", {
      method: "POST", body: JSON.stringify([{ sql: "SELECT COUNT(*) AS n FROM webhook_events", values: [] }]) });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json())[0].results[0].n;
  };
  const body = JSON.stringify({ object: "instagram", entry: [{ id: "222", messaging: [{ message: {mid:"test-message"} }] }] });
  const sig = createHmac("sha256", "local-test-secret").update(body).digest("hex");
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await mf.dispatchFetch("https://demo.test/webhook", {method:"POST", body, headers:{"x-hub-signature-256":"sha256=" + sig}});
    assert.equal(response.status, 202, await response.text());
  }
  assert.equal(await count("222"), 1);
  assert.equal(await count("333"), 0);
  assert.equal((await main.prepare("SELECT ig_user_id FROM auth").first()).ig_user_id, "111");
  console.log("Linked account webhook isolation and retry checks passed");
} finally { await mf.dispose(); }
