import { expect, it } from "vitest";
import type { Env } from "../src/types";
import { workspaces } from "../src/workspaces";

it("keeps legacy traffic on the main database and isolates the second account", () => {
  const env = { DB: { prepare() {} }, PUBLIC_BASE_URL: "https://main.example.com",
    PUBLIC_APP_ORIGIN: "https://dashboard.example.com", META_APP_SECRET: "first",
    WORKSPACES: JSON.stringify([{ key: "SECOND", origin: "https://second.example.com", label: "Second", instagramId: "123" }]),
    SECOND_DB: { prepare() {} }, SECOND_META_APP_SECRET: "second", SECOND_META_APP_ID: "2",
    SECOND_META_VERIFY_TOKEN: "verify", SECOND_ENCRYPTION_KEY: "key" };
  const [main, second] = workspaces(env as unknown as Env);
  if (!main || !second) throw new Error("Expected two workspaces");
  expect(main.key).toBeUndefined();
  expect(main.resolve().DB).toBe(env.DB);
  expect(second.resolve().DB).toBe(env.SECOND_DB);
  expect(second.resolve().META_APP_SECRET).toBe("second");
  expect(second.resolve().REDIRECT_URI).toBe("https://second.example.com/auth/callback");
  env.SECOND_META_APP_SECRET = "";
  expect(second.resolve).toThrow();
  expect(main.resolve().META_APP_SECRET).toBe("first");
});
