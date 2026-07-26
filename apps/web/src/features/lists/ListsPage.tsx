/**
 * Home (spec/src/map-view.md §Home): the notebook opens on the lists — each
 * row shows the list's marker, name, place count, and a posts indicator when
 * posts exist. The home carries the actions that feed lists: New list, Import,
 * and the add-a-place field. The canvas overlays every list's places.
 */
import { markerKey } from "@placemarks/domain";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useListPreviews } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { useCanvasProjection } from "../../state/projection";
import { AddPlaceField } from "../search/AddPlaceField";
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
        <h1 className="font-display text-xl font-semibold tracking-tight text-ink">Lists</h1>
        <div className="flex items-center gap-2">
          {creating ? null : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-crisp bg-ink px-3 py-1.5 text-sm font-medium text-paper"
              data-testid="new-list"
            >
              + New list
            </button>
          )}
          <Link
            to="/settings"
            hash="import"
            className="rounded-crisp border border-hairline px-3 py-1.5 text-sm font-medium text-ink"
            data-testid="import-entry"
          >
            ⤓ Import
          </Link>
        </div>
      </div>

      {/* The add-a-place field sits on the home (spec/src/map-view.md §The
          add-a-place field): paste a map link, or search — both end in
          "pick a list". */}
      <div className="mt-3">
        <AddPlaceField />
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
        {(rows ?? []).map(({ list, placeCount, postCount }) => (
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
              {postCount > 0 ? (
                <Link
                  to="/list/$listId"
                  params={{ listId: list.id }}
                  hash="posts"
                  className="shrink-0 rounded-crisp px-2 py-0.5 text-xs font-medium text-ink underline"
                  data-testid="list-posts-link"
                >
                  ▸ {postCount === 1 ? "post" : `${postCount.toString()} posts`}
                </Link>
              ) : null}
            </div>
          </li>
        ))}
        {rows !== undefined && rows.length === 0 && !creating ? (
          <li className="py-6 text-sm text-ink/60">
            No lists yet. Create one, paste a map link above, or import your saved places.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
