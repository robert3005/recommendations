/** Reactive reads over the local repository via Dexie liveQuery. */
import type { GuideBlockView, List, Note, PlaceId, SavedPlaceView, Tag } from "@placemarks/domain";
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
  return useLiveQuery(
    () => (placeId ? repo.listNotesForPlace(placeId) : []),
    [repo, placeId],
  );
}

export function useTags(): Tag[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.listTags(), [repo]);
}

export function useLists(): List[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => repo.listLists(), [repo]);
}

export function useGuide(listId: string | undefined): List | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (listId ? repo.getList(listId) : undefined), [repo, listId]);
}

export function useGuideBlocks(listId: string | undefined): GuideBlockView[] | undefined {
  const repo = useRepo();
  return useLiveQuery(() => (listId ? repo.getGuideBlocks(listId) : []), [repo, listId]);
}
