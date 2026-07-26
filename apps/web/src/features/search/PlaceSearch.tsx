/**
 * One field, two front doors.
 *
 * Type to search OpenStreetMap, or paste a Google Maps / Apple Maps /
 * OpenStreetMap link. Import stays the bulk path (spec/src/interop.md); this is
 * the "someone just told me about a place" path, which previously required
 * running Takeout for a single café.
 *
 * It lives in the content pane, not the map chrome, because the app opens on the
 * Lists home with the canvas hidden — search that only exists on a visible map
 * is search that does not exist.
 */
import type { OsmElementRef, ResolvedPoi } from "@placemarks/domain";
import { useState } from "react";
import { useLists } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { newId } from "../../lib/id";
import { nowIso } from "../../lib/time";
import { poiResolver } from "../../providers";
import { useUiStore } from "../../state/ui";
import { type ParsedPlaceLink, parsePlaceLink } from "../interop/placeLinks";
import type { ListTarget } from "../lists/ListTargetPicker";
import { AddFromLinkDialog } from "./AddFromLinkDialog";
import { SearchBar } from "./SearchBar";

export interface PlaceSearchProps {
  /** Bias search toward the current viewport when the map has one. */
  bias?: { lat: number; lng: number };
}

export function PlaceSearch({ bias }: PlaceSearchProps) {
  const repo = useRepo();
  const lists = useLists();
  const selectOsm = useUiStore((s) => s.selectOsm);
  const selectPlace = useUiStore((s) => s.selectPlace);
  const requestFlyTo = useUiStore((s) => s.requestFlyTo);

  const [link, setLink] = useState<ParsedPlaceLink>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  /** Create (or reuse) the target list, then hand back its id. */
  const listIdFor = async (target: ListTarget): Promise<string> => {
    if (target.kind === "existing") return target.listId;
    const id = newId();
    const now = nowIso();
    await repo.createList({
      id,
      name: target.name,
      marker: target.marker,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  };

  const addFromLink = async (name: string, target: ListTarget) => {
    if (!link) return;
    setBusy(true);
    setError(undefined);
    try {
      const listId = await listIdFor(target);
      const now = nowIso();
      const externalRef =
        link.provider === "google-maps"
          ? {
              provider: "google-maps" as const,
              url: link.url,
              ...(link.fid ? { fid: link.fid } : {}),
              importedAt: now,
            }
          : { provider: "web" as const, url: link.url, importedAt: now };

      // An OSM element link resolves to real evidence — the place is OSM-bound
      // from birth rather than a coordinate we later try to match.
      let poi: ResolvedPoi | undefined;
      if (link.osmRef) {
        poi = await resolveQuietly(link.osmRef);
        if (!poi && !link.coords) {
          setError("Could not reach OpenStreetMap to look this up. Try again when you are online.");
          return;
        }
      }

      const view = poi
        ? await repo.addToList(listId, { kind: "poi", poi, externalRef }, now)
        : await repo.addToList(
            listId,
            {
              kind: "import",
              facts: {
                name,
                lat: link.coords?.lat ?? 0,
                lng: link.coords?.lng ?? 0,
              },
              externalRef,
            },
            now,
          );

      setLink(undefined);
      selectPlace(view.place.id);
      if (link.coords) requestFlyTo({ ...link.coords, zoom: 17 });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SearchBar
        {...(bias ? { bias } : {})}
        onPasteLink={(raw) => {
          const parsed = parsePlaceLink(raw);
          if (!parsed) return false;
          setError(undefined);
          setLink(parsed);
          return true;
        }}
        onSelect={(result) => {
          selectOsm(result.ref, {
            name: result.name,
            lat: result.lat,
            lng: result.lng,
            ...(result.category ? { category: result.category } : {}),
          });
          requestFlyTo({ lat: result.lat, lng: result.lng, zoom: 17 });
        }}
      />
      {link ? (
        <AddFromLinkDialog
          link={link}
          lists={lists}
          {...(error ? { error } : {})}
          busy={busy}
          onAdd={(name, target) => void addFromLink(name, target)}
          onCancel={() => {
            setLink(undefined);
            setError(undefined);
          }}
        />
      ) : null}
    </>
  );
}

/** A resolver failure is not fatal when the link also carried coordinates. */
async function resolveQuietly(ref: OsmElementRef): Promise<ResolvedPoi | undefined> {
  try {
    const outcome = await poiResolver.resolveExact(ref);
    return outcome.type === "ok" ? outcome.poi : undefined;
  } catch {
    return undefined;
  }
}
