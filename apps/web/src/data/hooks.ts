/** Reactive reads over the local repository via Dexie liveQuery. */
import type {
  GuideBlockView,
  List,
  Note,
  OsmElementRef,
  PlaceId,
  SavedPlaceView,
  Tag,
} from "@placemarks/domain";
import { useLiveQuery } from "dexie-react-hooks";
import { useRepo } from "./RepoContext";

export function useSavedPlaceViews(): SavedPlaceView[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.listSavedPlaces(), [repo]);
}

export function useSavedPlaceView(savedPlaceId: string | undefined): SavedPlaceView | undefined {
  const repo = useRepo();
  return useLiveQuery(
    () => (savedPlaceId ? repo.getSavedPlace(savedPlaceId) : undefined),
    [repo, savedPlaceId],
  );
}

export function useNotesForPlace(placeId: PlaceId | undefined): Note[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (placeId ? repo.listNotesForPlace(placeId) : []), [repo, placeId]);
}

/** The live SavedPlace for an OSM ref (current or historical), if any. */
export function useSavedPlaceForRef(ref: OsmElementRef | undefined) {
  const repo = useRepo();
  return useLiveQuery(async () => {
    if (!ref) return undefined;
    const place = await repo.findPlaceByOsmRef(ref);
    if (!place) return undefined;
    return repo.findSavedPlaceByPlaceId(place.id);
  }, [repo, ref?.type, ref?.id]);
}

export function useTags(): Tag[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.listTags(), [repo]);
}

export function useLists(): List[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.listLists(), [repo]);
}

/** savedPlaceId → listIds for pin colouring on the map. */
export function useListMembership(): Record<string, string[]> | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.listMembershipBySavedPlace(), [repo]);
}

/** Ids of lists already containing this saved place (dropdown filtering). */
export function useListIdsForSavedPlace(savedPlaceId: string | undefined): string[] | undefined {
  const repo = useRepo();
  return useLiveQuery(
    () => (savedPlaceId ? repo.listIdsForSavedPlace(savedPlaceId) : []),
    [repo, savedPlaceId],
  );
}

export function useGuide(listId: string | undefined): List | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (listId ? repo.getList(listId) : undefined), [repo, listId]);
}

export function useGuideBlocks(listId: string | undefined): GuideBlockView[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (listId ? repo.getGuideBlocks(listId) : []), [repo, listId]);
}
