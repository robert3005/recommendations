/** Reactive reads over the local repository via Dexie liveQuery. */

import type {
  ImportBatch,
  ImportItem,
  List,
  ListEntry,
  Place,
  PlaceId,
  Post,
  PostTarget,
  Publication,
  SavedView,
} from "@placemarks/domain";
import { liveQuery } from "dexie";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import { useDexieRepo, useRepo } from "./RepoContext";
import type { LocalRepository, PlaceView } from "./repo";

/** The most often a library-wide query hands React a new result. */
const LIBRARY_QUERY_INTERVAL_MS = 250;

/**
 * useLiveQuery for queries over the whole library, delivering at most one
 * new result per LIBRARY_QUERY_INTERVAL_MS. Every delivery re-derives facets
 * and redraws every pin, so an import writing hundreds of rows spent its time
 * re-rendering after each one. The first result after a quiet spell arrives
 * at once, so a single edit still shows immediately; the last one always
 * arrives.
 */
function useLibraryQuery<T>(repo: LocalRepository, querier: () => Promise<T>): T | undefined {
  const [value, setValue] = useState<T>();
  const querierRef = useRef(querier);
  querierRef.current = querier;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different repository is a different query; the querier itself is read through the ref.
  useEffect(() => {
    let lastDelivery = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest: { value: T } | undefined;
    const deliver = () => {
      timer = undefined;
      if (!latest) return;
      const next = latest.value;
      latest = undefined;
      lastDelivery = performance.now();
      setValue(() => next);
    };
    const subscription = liveQuery(() => querierRef.current()).subscribe({
      next: (result) => {
        latest = { value: result };
        if (timer !== undefined) return;
        const wait = lastDelivery + LIBRARY_QUERY_INTERVAL_MS - performance.now();
        if (wait <= 0) deliver();
        else timer = setTimeout(deliver, wait);
      },
      error: (err) => console.error(err),
    });
    return () => {
      subscription.unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [repo]);
  return value;
}

/** Every place in the library, with the lists it is on (possibly none). */
export function usePlaceViews(): PlaceView[] | undefined {
  const repo = useRepo();
  return useLibraryQuery(repo, () => repo.listPlaceViews());
}

export function usePlaceView(placeId: PlaceId | undefined): PlaceView | undefined {
  const repo = useRepo();
  return useLiveQuery(async () => {
    if (!placeId) return undefined;
    const views = await repo.listPlaceViews();
    return views.find((v) => v.place.id === placeId);
  }, [repo, placeId]);
}

export function usePlace(placeId: PlaceId | undefined): Place | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (placeId ? repo.getPlace(placeId) : undefined), [repo, placeId]);
}

export function useLists(): List[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.listLists(), [repo]);
}

export function useViews(): SavedView[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.listViews(), [repo]);
}

export function useList(listId: string | undefined): List | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (listId ? repo.getList(listId) : undefined), [repo, listId]);
}

/** A list's entries in (rank, id) order, joined with their places. */
export function useListEntries(
  listId: string | undefined,
): { entry: ListEntry; place: Place }[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (listId ? repo.entriesOf(listId) : []), [repo, listId]);
}

/** placeId → listIds for pin marker resolution on the map. */
export function useListMembership(): Record<string, string[]> | undefined {
  const repo = useRepo();
  return useLibraryQuery(repo, async () => {
    const membership: Record<string, string[]> = {};
    for (const view of await repo.listPlaceViews()) membership[view.place.id] = view.listIds;
    return membership;
  });
}

export function usePosts(): Post[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.allPosts(), [repo]);
}

export function usePostsFor(target: PostTarget | undefined): Post[] | undefined {
  const repo = useRepo();
  const key = target ? JSON.stringify(target) : undefined;
  return useLiveQuery(() => (target ? repo.postsFor(target) : []), [repo, key]);
}

export function usePost(postId: string | undefined): Post | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (postId ? repo.getPost(postId) : undefined), [repo, postId]);
}

/** The latest publication row for a target — live or revoked tombstone. */
export function usePublicationFor(
  target: Publication["target"] | undefined,
): Publication | undefined {
  const repo = useRepo();
  const key = target ? `${target.kind}:${target.id}` : undefined;
  return useLiveQuery(() => (target ? repo.publicationFor(target) : undefined), [repo, key]);
}

export function useLivePublications(): Publication[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.livePublications(), [repo]);
}

/** Lists-home row data (spec/src/map-view.md): each list with its place count. */
export interface ListPreview {
  list: List;
  placeCount: number;
}

export function useListPreviews(): ListPreview[] | undefined {
  const repo = useRepo();
  return useLibraryQuery(repo, async () => {
    const lists = await repo.listLists();
    return Promise.all(
      lists.map(async (list): Promise<ListPreview> => {
        const entries = await repo.entriesOf(list.id);
        return { list, placeCount: entries.length };
      }),
    );
  });
}

export function useImportBatches(): ImportBatch[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.listImportBatches(), [repo]);
}

export function useImportItems(batchId: string | undefined): ImportItem[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (batchId ? repo.itemsOf(batchId) : []), [repo, batchId]);
}

/** Import rows waiting in the review queue, across batches (spec/src/interop.md). */
export function useReviewItems(): ImportItem[] | undefined {
  const repo = useDexieRepo();
  return useLiveQuery(() => repo.db.importItems.where("status").equals("review").toArray(), [repo]);
}

/**
 * The top bar's review pill (spec/src/map-view.md §The grammar): the count of
 * import rows waiting in review, but only while some batch is still reviewing
 * — 0 otherwise, and the pill does not render.
 */
export function useReviewingCount(): number | undefined {
  const repo = useDexieRepo();
  return useLiveQuery(async () => {
    const reviewing = await repo.db.importBatches.where("status").equals("reviewing").count();
    if (reviewing === 0) return 0;
    return repo.db.importItems.where("status").equals("review").count();
  }, [repo]);
}

export function useSetting<T>(key: string): T | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.getSetting<T>(key), [repo, key]);
}
