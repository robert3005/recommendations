/**
 * Post-body link forms (spec/src/posts.md §Link forms, spec/src/sharing.md
 * §Publish-time link rewrite): `[text](place:<id>)` is a mention,
 * `[text](post:<id>)` a cross-post link. Both are soft — a dangling target
 * renders as plain text. Operates on the Markdown SOURCE: regex over inline
 * links is fine because bodies are CommonMark the app itself authored.
 */

export const PLACE_PROTOCOL = "place:";
export const POST_PROTOCOL = "post:";

const INLINE_LINK = /\[([^\]]*)\]\(\s*(place|post):([^)\s]+)\s*\)/g;

function extractIds(body: string, protocol: "place" | "post"): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const match of body.matchAll(INLINE_LINK)) {
    if (match[2] !== protocol) continue;
    const id = match[3] as string;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** `place:<id>` mention targets, in order of first appearance, deduped. */
export function extractMentionIds(body: string): string[] {
  return extractIds(body, "place");
}

/** `post:<id>` cross-post link targets, in order of first appearance, deduped. */
export function extractPostLinkIds(body: string): string[] {
  return extractIds(body, "post");
}

/**
 * Publish-time rewrite: published bodies never contain custom protocols.
 * `place:<id>` → `#place-<id>` when the place is in the published set, else
 * the link unwraps to its text; `post:<id>` → the target's public URL when
 * published, else unwraps.
 */
export function rewriteBodyForPublish(
  body: string,
  opts: { placeIdsInDoc: ReadonlySet<string>; postUrls: ReadonlyMap<string, string> },
): string {
  return body.replace(INLINE_LINK, (_whole, text: string, protocol: string, id: string) => {
    if (protocol === "place") {
      return opts.placeIdsInDoc.has(id) ? `[${text}](#place-${id})` : text;
    }
    const url = opts.postUrls.get(id);
    return url ? `[${text}](${url})` : text;
  });
}
