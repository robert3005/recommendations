/**
 * Place detail sheet for a selected OSM element: exact resolution with live
 * fields, designed failure states, and a single OSM portal link
 * (book/src/map-view.md).
 */
import { refKey } from "@placemarks/domain";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useSavedPlaceForRef } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { poiResolver } from "../../providers";
import { type Selection, useUiStore } from "../../state/ui";
import { OsmLink } from "./OsmLink";
import { PlaceFields } from "./PlaceFields";
import { SavedPlaceSheet } from "./SavedPlaceSheet";

function SheetShell({ children, label }: { children: React.ReactNode; label: string }) {
  const clearSelection = useUiStore((s) => s.clearSelection);
  return (
    <section
      role="dialog"
      aria-label={label}
      className="absolute inset-x-0 bottom-0 z-20 max-h-[60%] overflow-y-auto rounded-t-2xl border border-stone-200 bg-white p-4 shadow-xl md:inset-x-auto md:right-4 md:bottom-4 md:w-96 md:rounded-2xl"
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
  const selectSaved = useUiStore((s) => s.selectSaved);
  const existingSave = useSavedPlaceForRef(ref);
  const resolveQuery = useQuery({
    queryKey: ["resolve", refKey(ref)],
    queryFn: ({ signal }) => poiResolver.resolveExact(ref, { signal }),
  });
  const saveMutation = useMutation({
    mutationFn: async () => {
      const outcome = resolveQuery.data;
      if (outcome?.type !== "ok") throw new Error("not resolved");
      return repo.savePoi(outcome.poi, nowIso());
    },
    onSuccess: (view) => selectSaved(view.savedPlace.id),
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
    return (
      <SheetShell label={label}>
        <PlaceFields {...(hint?.name ? { name: hint.name } : {})} source="live" />
        <p className="mt-2 text-sm text-red-700" data-testid="sheet-gone">
          This element no longer exists on OpenStreetMap.
        </p>
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
      <div className="mt-3">
        {existingSave ? (
          <button
            type="button"
            onClick={() => selectSaved(existingSave.id)}
            className="rounded bg-stone-800 px-3 py-1.5 text-sm font-medium text-white"
            data-testid="open-saved"
          >
            Open saved place
          </button>
        ) : (
          <button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="rounded bg-rose-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            data-testid="save-place"
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </button>
        )}
      </div>
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
  return <SavedPlaceSheet savedPlaceId={selection.savedPlaceId} />;
}
