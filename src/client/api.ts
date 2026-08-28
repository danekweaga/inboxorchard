export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new ApiError(typeof body.error === "string" ? body.error : `Request failed (${response.status})`, response.status);
  return body as T;
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

export function put<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) });
}

export function patch<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) });
}

export function remove<T>(path: string): Promise<T> {
  return api<T>(path, { method: "DELETE" });
}
