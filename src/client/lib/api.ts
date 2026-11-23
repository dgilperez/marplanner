import { authFetch } from "@/lib/credential";

type FetchInit = Parameters<typeof fetch>[1];

/** A response outside 2xx. `code` is the stable code of the API's error body, so callers choose
 * their copy by code and never show server prose. Routes put it in `error`; the gates in front of
 * them (the plugin lifecycle's 503, the auth boundary) put it in `code`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    url: string
  ) {
    super(`${url}: ${status}`);
  }
}

/** Authenticated request that rejects with `ApiError` unless the response is 2xx. */
export async function apiFetch(url: string, init?: FetchInit): Promise<Response> {
  const response = await authFetch(url, { credentials: "include", ...init });
  if (response.ok) return response;
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    code?: unknown;
  } | null;
  const code = [body?.error, body?.code].find((value) => typeof value === "string");
  throw new ApiError(response.status, code ?? null, url);
}

export async function readJson<T>(url: string, init?: FetchInit): Promise<T> {
  return (await (await apiFetch(url, init)).json()) as T;
}

/** Request options for a JSON body. */
export function jsonRequest(method: string, body: unknown): FetchInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
