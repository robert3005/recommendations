/** Reactive reads over the local repository via Dexie liveQuery. */
import type {
  GuideBlockView,
  List,
  Note,
  OsmElementRef,
  PlaceId,
  PlaceView,
  Tag,
} from "@placemarks/domain";
import { useLiveQuery } from "dexie-react-hooks";
import { useRepo } from "./RepoContext";

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

export function useGuide(listId: string | undefined): List | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (listId ? repo.getList(listId) : undefined), [repo, listId]);
}

export function useGuideBlocks(listId: string | undefined): GuideBlockView[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (listId ? repo.getGuideBlocks(listId) : []), [repo, listId]);
}
