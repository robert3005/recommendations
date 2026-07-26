/**
 * Mention-based article ↔ map sync (spec/src/posts.md §Reading): selecting a
 * mention flies the camera to its place; selecting a pin scrolls the article
 * to that place's first mention. The active mentions are the body's place:
 * targets that fall inside the post's projection — anything outside it is
 * plain text and has no pin to sync with.
 */
import { extractMentionIds } from "@placemarks/domain";

/** Projected mention targets in body order, deduped. */
export function activeMentionIds(body: string, projectedPlaceIds: ReadonlySet<string>): string[] {
  return extractMentionIds(body).filter((id) => projectedPlaceIds.has(id));
}

/** The scroll target for a pin tap: the first rendered mention of the place. */
export function mentionElementFor(root: ParentNode, placeId: string): HTMLElement | null {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(placeId)
      : placeId.replace(/["\\]/g, "\\$&");
  return root.querySelector<HTMLElement>(`[data-mention-place="${escaped}"]`);
}
