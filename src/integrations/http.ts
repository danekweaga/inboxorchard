import { isSafeHttpsUrl } from "../automation/validator";

export async function callExternalHttp(input: {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}): Promise<{ status: number; body: unknown }> {
  if (!isSafeHttpsUrl(input.url)) throw new Error("Outbound HTTP URL is not an allowed public HTTPS address");
  const headers = new Headers(input.headers ?? {});
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("cookie");
  headers.delete("authorization");
  if (input.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(input.url, {
    method: input.method ?? "POST",
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    redirect: "error",
    signal: AbortSignal.timeout(Math.max(1000, Math.min(15000, input.timeoutMs ?? 8000))),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : (await response.text()).slice(0, 10000);
  if (!response.ok) throw new Error(`Outbound HTTP request failed with ${response.status}`);
  return { status: response.status, body };
}
