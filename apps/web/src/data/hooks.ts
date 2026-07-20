/** Reactive reads over the local repository via Dexie liveQuery. */

import type {
  List,
  ListBlockView,
  Note,
  OsmElementRef,
  PlaceId,
  PlaceView,
  Post,
  PostBlockView,
  Tag,
} from "@placemarks/domain";
import { displayFacts } from "@placemarks/domain";
import { useLiveQuery } from "dexie-react-hooks";
import type { ImportItemRow } from "./db";
import { useDexieRepo, useRepo } from "./RepoContext";

/** Every place in the library — i.e. every place in at least one list. */
export function useLibraryPlaces(): PlaceView[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.listPlaces(), [repo]);
}

export function usePlaceView(placeId: PlaceId | undefined): PlaceView | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (placeId ? repo.getPlaceView(placeId) : undefined), [repo, placeId]);
}

/** The in-library place for an OSM ref (current or historical), if any. */
export function usePlaceForRef(ref: OsmElementRef | undefined) {
  const repo = useRepo();
  return useLiveQuery(async () => {
    if (!ref) return undefined;
    const place = await repo.findPlaceByOsmRef(ref);
    if (!place) return undefined;
    // Membership is existence: only a listed place counts as "in the library".
    const listIds = await repo.listIdsForPlace(place.id);
    return listIds.length > 0 ? place : undefined;
  }, [repo, ref?.type, ref?.id]);
}

export function useNotesForPlace(placeId: PlaceId | undefined): Note[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (placeId ? repo.listNotesForPlace(placeId) : []), [repo, placeId]);
}

export function useTags(): Tag[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.listTags(), [repo]);
}

export function useLists(): List[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.listLists(), [repo]);
}

/** placeId → listIds for pin colouring on the map. */
export function useListMembership(): Record<string, string[]> | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.listMembershipByPlace(), [repo]);
}

/** Ids of lists already containing this place (dropdown filtering). */
export function useListIdsForPlace(placeId: PlaceId | undefined): string[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (placeId ? repo.listIdsForPlace(placeId) : []), [repo, placeId]);
}

export function useList(listId: string | undefined): List | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (listId ? repo.getList(listId) : undefined), [repo, listId]);
}

export function useListBlocks(listId: string | undefined): ListBlockView[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (listId ? repo.getListBlocks(listId) : []), [repo, listId]);
}

export function usePosts(): Post[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.listPosts(), [repo]);
}

export function usePostsForList(listId: string | undefined): Post[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (listId ? repo.listPostsForList(listId) : []), [repo, listId]);
}

export function usePost(postId: string | undefined): Post | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (postId ? repo.getPost(postId) : undefined), [repo, postId]);
}

export function usePostBlocks(postId: string | undefined): PostBlockView[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (postId ? repo.getPostBlocks(postId) : []), [repo, postId]);
}

/**
 * Lists-home row data (spec/src/map-view.md §The Lists home): each list with
 * its place count and the first place names in list order for the truncated
 * inline preview.
 */
export interface ListPreview {
  list: List;
  placeCount: number;
  postCount: number;
  previewNames: string[];
}

const PREVIEW_NAMES = 4;

export function useListPreviews(): ListPreview[] | undefined {
  const repo = useRepo();
  return useLiveQuery(async () => {
    const lists = await repo.listLists();
    return Promise.all(
      lists.map(async (list): Promise<ListPreview> => {
        const blocks = await repo.getListBlocks(list.id);
        const posts = await repo.listPostsForList(list.id);
        return {
          list,
          placeCount: blocks.length,
          postCount: posts.length,
          previewNames: blocks
            .slice(0, PREVIEW_NAMES)
            .map((view) => displayFacts(view.place)?.name ?? "Unnamed"),
        };
      }),
    );
  }, [repo]);
}

/** Import rows waiting in the review queue (spec/src/interop.md). */
export function useReviewItems(): ImportItemRow[] | undefined {
  const repo = useDexieRepo();
  return useLiveQuery(
    () => repo.db.importItems.filter((i) => i.status === "review").toArray(),
    [repo],
  );
}
