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
} from "@placemarks/domain";
import { useLiveQuery } from "dexie-react-hooks";
import { useDexieRepo, useRepo } from "./RepoContext";
import type { PlaceView } from "./repo";

/** Every place in the library — i.e. every place in at least one list. */
export function usePlaceViews(): PlaceView[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.listPlaceViews(), [repo]);
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
  return useLiveQuery(async () => {
    const membership: Record<string, string[]> = {};
    for (const view of await repo.listPlaceViews()) membership[view.place.id] = view.listIds;
    return membership;
  }, [repo]);
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

/**
 * Lists-home row data (spec/src/map-view.md): each list with its place count,
 * its posts indicator, and the first place names for the inline preview.
 */
export interface ListPreview {
  list: List;
  placeCount: number;
  postCount: number;
}

export function useListPreviews(): ListPreview[] | undefined {
  const repo = useRepo();
  return useLiveQuery(async () => {
    const lists = await repo.listLists();
    return Promise.all(
      lists.map(async (list): Promise<ListPreview> => {
        const entries = await repo.entriesOf(list.id);
        const posts = await repo.postsFor({ kind: "list", listId: list.id });
        return {
          list,
          placeCount: entries.length,
          postCount: posts.length,
        };
      }),
    );
  }, [repo]);
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

export function useSetting<T>(key: string): T | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.getSetting<T>(key), [repo, key]);
}
