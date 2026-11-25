/**
 * Request sending: header/body handling, refusing redirects, size-limited body reads.
 * No Stream Deck imports, so it can be unit-tested against plain local servers.
 */

export type RequestSettings = {
  url?: string;
  method?: string;
  headers?: string; // one "Name: value" per line
  body?: string;
  timeout?: number; // seconds
  pollMs?: number;
};

export const NO_BODY = new Set(["GET", "HEAD"]);
export const MIN_POLL_MS = 250;
export const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MiB

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type FetchOptions = {
  /** Replaceable for tests. */
  fetch?: typeof fetch;
};

export class TooLargeError extends Error {}
/** The server answered with a redirect, which is never followed. */
export class RedirectError extends Error {}

export function parseHeaders(raw = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function isJson(t: string): boolean {
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/** URL without query/fragment/credentials, so tokens in the URL never reach the log. */
export function safeUrl(u = ""): string {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

/** Read the body as text, giving up if it exceeds `limit` bytes. */
export async function readLimited(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > limit) {
    await res.body?.cancel();
    throw new TooLargeError(`Response too large (${declared} bytes)`);
  }
  if (!res.body) return "";

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new TooLargeError(`Response exceeded ${limit} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Longest a poll may wait: a hung API shouldn't stall retries for the full timeout. */
export function pollTimeoutMs(s: RequestSettings): number {
  return Math.max(3000, 3 * Math.max(Number(s.pollMs) || 0, MIN_POLL_MS));
}

/** Timeout in ms for a request made with these settings (1-120 s, empty/0/invalid = 10 s; capped when polling). */
export function requestTimeoutMs(s: RequestSettings, polling: boolean): number {
  const seconds = Math.min(Math.max(Number(s.timeout) || 10, 1), 120);
  return polling ? Math.min(seconds * 1000, pollTimeoutMs(s)) : seconds * 1000;
}

export async function send(
  s: RequestSettings,
  signal: AbortSignal,
  polling: boolean,
  opts: FetchOptions = {},
): Promise<{ ok: boolean; status: number; text: string }> {
  const method = (s.method ?? "POST").toUpperCase();
  const timeoutMs = requestTimeoutMs(s, polling);
  const headers = parseHeaders(s.headers);
  const hasBody = !NO_BODY.has(method) && !!s.body;

  // Node sends string bodies as text/plain; default to JSON when the body is JSON.
  if (hasBody && isJson(s.body!) && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }

  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const res = await fetchNoRedirects(s.url!, method, headers, hasBody ? s.body : undefined, combined, opts);
  return { ok: res.ok, status: res.status, text: await readLimited(res, MAX_RESPONSE_BYTES) };
}

/**
 * Redirects are never followed. A redirect would make the plugin re-send the request somewhere the user did
 * not configure, and could leak custom headers, the body or the query string to another host. The response is
 * fetched with `redirect: "manual"` and any redirect (3xx with a Location header) is refused with a RedirectError.
 */
export async function fetchNoRedirects(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal: AbortSignal,
  opts: FetchOptions = {},
): Promise<Response> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(url, { method, headers, body, redirect: "manual", signal });
  if (REDIRECT_STATUSES.has(res.status) && res.headers.get("location")) {
    await res.body?.cancel();
    throw new RedirectError(`Refused HTTP ${res.status} redirect; redirects are not followed`);
  }
  return res;
}
/**
 * One-line description of a failed request, for the log. The messages of TypeErrors thrown while building a request
 * quote the URL or header that was wrong, tokens included, so those are never passed on.
 */
export function describeError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } } | undefined;
  if (e?.name === "TimeoutError") return "timed out";
  if (err instanceof TooLargeError || err instanceof RedirectError) return err.message;
  const cause = e?.cause?.code ?? e?.cause?.message;
  if (err instanceof TypeError && err.message !== "fetch failed") {
    return e?.cause?.code === "ERR_INVALID_URL"
      ? "invalid URL (it must start with http:// or https://)"
      : "invalid request (check the URL and headers)";
  }
  return cause ? `${e?.message ?? "error"} (${cause})` : (e?.message ?? String(err));
}

/** Failures we expect in normal use (server down, DNS, timeout, refused redirect); logged as one line without a stack. */
export function isExpectedNetworkError(err: unknown): boolean {
  return err instanceof TooLargeError || err instanceof RedirectError || (err as Error)?.name === "TimeoutError" || err instanceof TypeError;
}
