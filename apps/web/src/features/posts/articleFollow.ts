/**
 * Map-follow groups for an interleaved post. A prose section owns the place
 * embeds that follow it up to the next prose section. A trailing section with
 * no following embeds falls back to the nearest preceding embed so every
 * authored section still has a useful spatial counterpart when the post has
 * at least one place.
 */
export interface ArticleFollowRow {
  blockId: string;
  /** Present for place embeds; absent for prose sections. */
  placeId?: string;
}

export function articleFollowGroups(rows: readonly ArticleFollowRow[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    if (row.placeId) {
      groups.set(row.blockId, [row.placeId]);
      continue;
    }

    const following: string[] = [];
    for (let cursor = index + 1; cursor < rows.length; cursor += 1) {
      const candidate = rows[cursor];
      if (!candidate) continue;
      if (!candidate.placeId) break;
      following.push(candidate.placeId);
    }
    if (following.length > 0) {
      groups.set(row.blockId, following);
      continue;
    }

    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const previous = rows[cursor];
      if (previous?.placeId) {
        groups.set(row.blockId, [previous.placeId]);
        break;
      }
    }
  }
  return groups;
}
