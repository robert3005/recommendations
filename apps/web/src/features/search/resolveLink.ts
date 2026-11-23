/**
 * Short-link expansion (spec/src/interop.md §One place via a link): the share
 * service follows a `maps.app.goo.gl` redirect and returns only the URL it
 * points at, which the caller parses locally like any pasted link. Nothing
 * queues — offline or failing, the caller falls back to asking for the full
 * URL.
 */
import { SHARE_API_URL } from "../../config";

export async function expandShortLink(url: string, signal?: AbortSignal): Promise<string> {
  const path = `${SHARE_API_URL}/s/resolve-link?url=${encodeURIComponent(url)}`;
  const target =
    typeof window === "undefined" ? path : new URL(path, window.location.href).toString();
  const response = await fetch(target, { signal: signal ?? null });
  if (!response.ok) throw new Error(`resolve-link ${response.status}`);
  const body = (await response.json()) as { url?: unknown };
  if (typeof body.url !== "string") throw new Error("resolve-link: no url");
  return body.url;
}
