/**
 * Wikipedia REST summary lookup (spec/src/data-sources.md §Wikipedia
 * summaries): resolves an OSM element's `wikipedia` tag ("lang:Article Title";
 * lang defaults to "en" when the tag has no prefix) against
 * https://<lang>.wikipedia.org/api/rest_v1/page/summary/<encoded title> — no
 * key, CORS-open. The provider sees only the article title the element names.
 *
 * The extract is truncated to 600 characters at capture (the published
 * description cap), and the thumbnail is used only when Wikimedia-hosted —
 * the standing wikimedia-only image rule (spec/src/data-model.md).
 */

export interface WikipediaSummary {
  extract?: string;
  thumbnailUrl?: string;
  articleUrl?: string;
}

/** The published description cap (packages/schemas published.ts). */
const EXTRACT_MAX_CHARS = 600;

const WIKIMEDIA_HOSTS = new Set(["commons.wikimedia.org", "upload.wikimedia.org"]);

/** A tag prefix counts as a wiki language code only when it looks like one. */
const LANG_PREFIX = /^[a-z]{2,12}(?:-[a-z0-9]+)*$/;

function parseTag(tag: string): { lang: string; title: string } | undefined {
  const colon = tag.indexOf(":");
  if (colon > 0) {
    const prefix = tag.slice(0, colon).trim();
    const title = tag.slice(colon + 1).trim();
    if (LANG_PREFIX.test(prefix) && title !== "") return { lang: prefix, title };
  }
  const title = tag.trim();
  return title === "" ? undefined : { lang: "en", title };
}

function wikimediaThumbnail(source: unknown): string | undefined {
  if (typeof source !== "string") return undefined;
  try {
    const url = new URL(source);
    if (url.protocol === "https:" && WIKIMEDIA_HOSTS.has(url.hostname)) return source;
  } catch {
    // not an absolute URL — rejected
  }
  return undefined;
}

interface SummaryBody {
  extract?: string;
  thumbnail?: { source?: string };
  content_urls?: { desktop?: { page?: string } };
}

/**
 * Best-effort by contract: a missing article (or any non-OK response) is
 * `undefined`; network failures throw and the caller stays silent
 * (spec/src/data-model.md — enrichment never surfaces an error).
 */
export async function wikipediaSummary(
  tag: string,
  opts?: { signal?: AbortSignal },
): Promise<WikipediaSummary | undefined> {
  const parsed = parseTag(tag);
  if (!parsed) return undefined;
  const url = `https://${parsed.lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(parsed.title)}`;
  const response = await fetch(url, { signal: opts?.signal ?? null });
  if (!response.ok) return undefined;
  const body = (await response.json()) as SummaryBody;
  const extract =
    typeof body.extract === "string" && body.extract !== ""
      ? body.extract.slice(0, EXTRACT_MAX_CHARS)
      : undefined;
  const thumbnailUrl = wikimediaThumbnail(body.thumbnail?.source);
  const page = body.content_urls?.desktop?.page;
  const articleUrl = typeof page === "string" && page.startsWith("https://") ? page : undefined;
  return {
    ...(extract !== undefined ? { extract } : {}),
    ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
    ...(articleUrl !== undefined ? { articleUrl } : {}),
  };
}
