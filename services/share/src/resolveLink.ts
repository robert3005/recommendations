/**
 * Short-link expansion (spec/src/interop.md §Paste a link): a
 * `maps.app.goo.gl` share link reveals nothing until its redirect is
 * followed, and a browser cannot read a cross-origin redirect. The service
 * follows it and hands back only the URL it points at — never a page body —
 * which the client then parses locally like any pasted Google Maps URL.
 *
 * The guard is strict in both directions so this is never an open proxy: only
 * Google's own share-link hosts are requested, redirects are followed by hand
 * (a hop to any other host ends the walk), and only a Google Maps URL is ever
 * returned.
 */

/** The share-sheet short hosts; `goo.gl` only under its legacy `/maps/` path. */
const SHORT_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl)$/;
/** Google Maps hosts a short link may land on (mirrors the domain link parser). */
const GOOGLE_MAPS_HOSTS = /^(www\.|maps\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/;
/** Google's cookie-consent interstitial carries the real target in `continue`. */
const CONSENT_HOST = "consent.google.com";

const MAX_INPUT_LENGTH = 300;
const MAX_OUTPUT_LENGTH = 4096;
const MAX_HOPS = 4;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type ResolveResult =
  | { ok: true; url: string }
  | { ok: false; reason: "not-a-short-link" | "unresolved" | "upstream" };

function parseHttps(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    // No credentials and no explicit port: just the plain public hosts.
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function isShortLink(url: URL): boolean {
  if (!SHORT_HOSTS.test(url.hostname)) return false;
  return url.hostname !== "goo.gl" || url.pathname.startsWith("/maps/");
}

export async function resolveShortLink(
  raw: string,
  fetchUpstream: FetchLike,
): Promise<ResolveResult> {
  if (raw.length > MAX_INPUT_LENGTH) return { ok: false, reason: "not-a-short-link" };
  let current = parseHttps(raw.trim());
  if (!current || !isShortLink(current)) return { ok: false, reason: "not-a-short-link" };

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let response: Response;
    try {
      response = await fetchUpstream(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return { ok: false, reason: "upstream" };
    }
    // Only the Location header is of interest — the body is never read.
    void response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      return { ok: false, reason: "unresolved" };
    }
    let next: URL | undefined;
    try {
      next = parseHttps(new URL(location, current).toString());
    } catch {
      next = undefined;
    }
    if (!next) return { ok: false, reason: "unresolved" };
    if (next.hostname === CONSENT_HOST) {
      next = parseHttps(next.searchParams.get("continue") ?? "");
      if (!next) return { ok: false, reason: "unresolved" };
    }
    if (GOOGLE_MAPS_HOSTS.test(next.hostname)) {
      const url = next.toString();
      return url.length <= MAX_OUTPUT_LENGTH
        ? { ok: true, url }
        : { ok: false, reason: "unresolved" };
    }
    if (!isShortLink(next)) return { ok: false, reason: "unresolved" };
    current = next;
  }
  return { ok: false, reason: "unresolved" };
}
