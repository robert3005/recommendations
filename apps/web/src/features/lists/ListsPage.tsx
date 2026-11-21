/**
 * Home (spec/src/map-view.md §Home): the notebook opens on the lists — each
 * row is marker, name, place count, nothing else. The home body carries the
 * actions that feed lists: New list and Import; the add-a-place field lives
 * in the shell's top bar. The canvas overlays every list's places.
 */
import { markerKey } from "@placemarks/domain";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useListPreviews } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { useCanvasProjection } from "../../state/projection";
import { MarkerGlyph } from "./MarkerGlyph";
import { NewListForm } from "./NewListForm";

export function ListsPage() {
  const repo = useRepo();
  const [creating, setCreating] = useState(false);
  const rows = useListPreviews();
  // Home projects every list's places, each pin wearing its list's marker
  // (spec/src/map-view.md §The grammar).
  useCanvasProjection({ kind: "lists-overlay" });

  // Beyond 64 live lists pairs repeat with a numeral badge as the
  // deterministic variant — derived from list order, never stored
  // (spec/src/data-model.md §Markers).
  const wearCounts = new Map<string, number>();
  const badges = new Map<string, number>();
  for (const { list } of rows ?? []) {
    const worn = (wearCounts.get(markerKey(list.marker)) ?? 0) + 1;
    wearCounts.set(markerKey(list.marker), worn);
    if (worn > 1) badges.set(list.id, worn);
  }

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="lists-page">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-[1.75rem] leading-tight font-medium tracking-tight text-ink">
          Lists
        </h1>
        <div className="flex items-center gap-2">
          {creating ? null : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-pill bg-ink px-3.5 py-1.5 text-sm font-medium text-paper shadow-lift"
              data-testid="new-list"
            >
              + New list
            </button>
          )}
          <Link
            to="/settings"
            hash="import"
            className="rounded-pill border border-hairline px-3 py-1.5 text-sm font-medium text-ink"
            data-testid="import-entry"
          >
            ⤓ Import
          </Link>
        </div>
      </div>

      {creating ? (
        <div className="mt-3">
          <NewListForm
            submitLabel="Create list"
            submitTestId="create-list"
            onCreate={(name) => {
              setCreating(false);
              void repo.createList(name);
            }}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : null}
      <ul className="mt-4 divide-y divide-hairline">
        {(rows ?? []).map(({ list, placeCount }) => (
          <li key={list.id} data-testid="list-row">
            <div className="flex items-center gap-3 px-1 py-3 hover:bg-ink/5">
              <MarkerGlyph
                marker={list.marker}
                size={20}
                {...(badges.has(list.id) ? { badge: badges.get(list.id) as number } : {})}
              />
              <Link
                to="/list/$listId"
                params={{ listId: list.id }}
                className="min-w-0 flex-1 truncate"
              >
                <span className="font-medium text-ink">{list.name}</span>
                <span className="ml-2 font-mono text-xs text-ink/60" data-testid="list-place-count">
                  {placeCount} {placeCount === 1 ? "place" : "places"}
                </span>
              </Link>
            </div>
          </li>
        ))}
        {rows !== undefined && rows.length === 0 && !creating ? (
          <li className="py-6 text-sm text-ink/60">
            No lists yet. Create one, paste a map link in the top bar, or import your saved places.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
