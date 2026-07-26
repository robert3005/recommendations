/**
 * The map follows the article (spec/src/posts.md §Reading): scrolling to a
 * section or embed frames its places.
 *
 * One observer, shared by the private post page and the public viewer. They had
 * a copy each — same 0.4 threshold, same visible-set bookkeeping, same
 * identity-preserving diff so an unchanged result does not re-render — differing
 * only in which data attribute marks a followable block. That is a parameter,
 * not a reason for two implementations.
 *
 * The returned array is sorted and referentially stable while its contents are
 * unchanged, so it is safe to pass straight into a projection.
 */
import { useEffect, useState } from "react";

/** The 40%-visible threshold: a block counts as read when most of it is on screen. */
const FOLLOW_THRESHOLD = 0.4;

export interface UseVisibleFollowKeysOptions {
  /** The scroll container holding the followable blocks. */
  rootRef: { current: HTMLElement | null };
  /** Data attribute marking a followable block, e.g. `data-post-follow`. */
  attribute: string;
  /** Block id → the keys (place ids, pin keys) that block frames. */
  groups: ReadonlyMap<string, string[]>;
  /**
   * Serialization of `groups`. The map identity changes on every render, so the
   * effect keys off this instead of re-subscribing constantly.
   */
  groupsKey: string;
  /** Called with the intersection entries, for behaviour beyond key collection. */
  onEntries?: (entries: IntersectionObserverEntry[]) => void;
}

export function useVisibleFollowKeys({
  rootRef,
  attribute,
  groups,
  groupsKey,
  onEntries,
}: UseVisibleFollowKeysOptions): string[] {
  const [keys, setKeys] = useState<string[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: groupsKey is the stable serialization of `groups`; onEntries is read through the latest render's closure.
  useEffect(() => {
    // A different set of followable blocks invalidates the previous answer —
    // most visibly when a viewer receives a newer document under the same
    // mount, where stale keys would leak the old document's places onto the map.
    setKeys([]);
    if (!groupsKey) return;
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const blockId = (entry.target as HTMLElement).dataset[datasetKey(attribute)];
          if (!blockId) continue;
          if (entry.isIntersecting) visible.add(blockId);
          else visible.delete(blockId);
        }
        const next = [
          ...new Set([...visible].flatMap((blockId) => groups.get(blockId) ?? [])),
        ].sort();
        setKeys((current) =>
          current.length === next.length && current.every((key, index) => key === next[index])
            ? current
            : next,
        );
        onEntries?.(entries);
      },
      { threshold: FOLLOW_THRESHOLD },
    );
    for (const element of root.querySelectorAll(`[${attribute}]`)) observer.observe(element);
    return () => observer.disconnect();
  }, [attribute, groupsKey, rootRef]);

  return keys;
}

/** `data-post-follow` → `postFollow`, matching how the DOM exposes it. */
function datasetKey(attribute: string): string {
  return attribute
    .replace(/^data-/, "")
    .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}
