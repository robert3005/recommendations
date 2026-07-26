/**
 * Place detail sheet for a selected OSM element: exact resolution with live
 * fields, designed failure states, and a single OSM portal link
 * (spec/src/map-view.md).
 */
import { refKey } from "@placemarks/domain";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useLists, usePlaceForRef } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { newId } from "../../lib/id";
import { nowIso } from "../../lib/time";
import { poiResolver } from "../../providers";
import { type Selection, useUiStore } from "../../state/ui";
import { AddToList } from "./AddToList";
import { OsmLink } from "./OsmLink";
import { PlaceDetailsSheet } from "./PlaceDetailsSheet";
import { PlaceFields } from "./PlaceFields";

function SheetShell({ children, label }: { children: React.ReactNode; label: string }) {
  const clearSelection = useUiStore((s) => s.clearSelection);
  // Modal focus: enter the sheet on open, return to the invoker on close.
  const sheetRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <section
      ref={sheetRef}
      tabIndex={-1}
      role="dialog"
      aria-label={label}
      className="absolute inset-x-0 bottom-0 z-40 max-h-[60%] overflow-y-auto rounded-t-2xl border border-stone-200 bg-white p-4 shadow-xl md:inset-x-auto md:right-4 md:bottom-4 md:w-96 md:rounded-2xl"
      data-testid="place-sheet"
    >
      <button
        type="button"
        onClick={clearSelection}
        aria-label="Close"
        className="absolute top-2 right-3 rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
      >
        ✕
      </button>
      {children}
    </section>
  );
}

function OsmSelectionSheet({ selection }: { selection: Extract<Selection, { kind: "osm" }> }) {
  const { ref, hint } = selection;
  const repo = useRepo();
  const selectPlace = useUiStore((s) => s.selectPlace);
  const openPicker = useUiStore((s) => s.openPicker);
  const existingPlace = usePlaceForRef(ref);
  const lists = useLists();
  const resolveQuery = useQuery({
    queryKey: ["resolve", refKey(ref)],
    queryFn: ({ signal }) => poiResolver.resolveExact(ref, { signal }),
  });

  const outcome = resolveQuery.data;
  const label = hint?.name ?? "Place details";

  if (resolveQuery.isPending) {
    return (
      <SheetShell label={label}>
        <PlaceFields {...(hint?.name ? { name: hint.name } : {})} source="live" />
        <p className="mt-2 text-sm text-stone-500" data-testid="sheet-loading">
          Loading OSM details…
        </p>
      </SheetShell>
    );
  }

  if (resolveQuery.isError || !outcome || outcome.type === "error") {
    return (
      <SheetShell label={label}>
        <PlaceFields {...(hint?.name ? { name: hint.name } : {})} source="live" />
        <p className="mt-2 text-sm text-stone-600" data-testid="sheet-error">
          OpenStreetMap is unreachable right now. This is not evidence the place is gone.
        </p>
        <button
          type="button"
          onClick={() => void resolveQuery.refetch()}
          className="mt-2 rounded bg-stone-800 px-3 py-1.5 text-sm font-medium text-white"
        >
          Retry
        </button>
      </SheetShell>
    );
  }

  if (outcome.type === "gone") {
    // A confirmed deletion keeps its designed affordances (spec/src/map-view.md):
    // retry, nearby-candidate review, and the OSM portal (history survives deletion).
    return (
      <SheetShell label={label}>
        <PlaceFields {...(hint?.name ? { name: hint.name } : {})} source="live" />
        <p className="mt-2 text-sm text-red-700" data-testid="sheet-gone">
          This element no longer exists on OpenStreetMap.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void resolveQuery.refetch()}
            className="rounded bg-stone-800 px-3 py-1.5 text-sm font-medium text-white"
          >
            Retry
          </button>
          {hint ? (
            <button
              type="button"
              onClick={() => openPicker({ lat: hint.lat, lng: hint.lng })}
              className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700"
              data-testid="find-candidates"
            >
              Find nearby candidates
            </button>
          ) : null}
        </div>
        <div className="mt-3">
          <OsmLink osmRef={ref} />
        </div>
      </SheetShell>
    );
  }

  const poi = outcome.poi;
  return (
    <SheetShell label={poi.name ?? label}>
      <PlaceFields
        {...(poi.name ? { name: poi.name } : {})}
        category={poi.category}
        {...(poi.address ? { address: poi.address } : {})}
        {...(poi.website ? { website: poi.website } : {})}
        {...(poi.phone ? { phone: poi.phone } : {})}
        {...(poi.openingHours ? { openingHours: poi.openingHours } : {})}
        source="live"
      />
      {existingPlace ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => selectPlace(existingPlace.id)}
            className="rounded bg-stone-800 px-3 py-1.5 text-sm font-medium text-white"
            data-testid="open-place"
          >
            Open place
          </button>
        </div>
      ) : null}
      {!existingPlace ? (
        <div className="mt-3">
          <h3 className="text-xs font-semibold tracking-wide text-stone-500 uppercase">Lists</h3>
          <AddToList
            lists={lists}
            memberListIds={[]}
            onPick={(target) => {
              // Adding a place to a list is how it comes to exist (membership is existence).
              void (async () => {
                let listId: string;
                if (target.kind === "new") {
                  listId = newId();
                  await repo.createList({
                    id: listId,
                    name: target.name,
                    marker: target.marker,
                    createdAt: nowIso(),
                    updatedAt: nowIso(),
                  });
                } else {
                  listId = target.list.id;
                }
                const view = await repo.addToList(listId, { kind: "poi", poi }, nowIso());
                selectPlace(view.place.id);
              })();
            }}
          />
        </div>
      ) : null}
      <div className="mt-3">
        <OsmLink osmRef={poi.osmRef} />
      </div>
    </SheetShell>
  );
}

export function PlaceSheet() {
  const selection = useUiStore((s) => s.selection);
  if (!selection) return null;
  if (selection.kind === "osm") return <OsmSelectionSheet selection={selection} />;
  return <PlaceDetailsSheet placeId={selection.placeId} />;
}
