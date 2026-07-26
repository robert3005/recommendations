/**
 * The Lists home (spec/src/map-view.md §The Lists home) — the pane's `/`
 * route and launch state: each list with its marker, name, place count, a
 * link to its posts when any exist, and a fixed-length truncated inline
 * preview of its contents. Carries the entry points that feed lists:
 * **New list** and **Import**. List contents stay read-only here; places
 * join from their cards on the canvas.
 */
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useListPreviews } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { newId } from "../../lib/id";
import { nowIso } from "../../lib/time";
import { useCanvasProjection } from "../../state/projection";
import { MarkerGlyph } from "./MarkerGlyph";
import { NewListForm } from "./NewListForm";

export function ListsPage() {
  const repo = useRepo();
  const previews = useListPreviews();
  const [creating, setCreating] = useState(false);
  const lists = previews?.map((p) => p.list);
  // Home projects all lists — every point wearing its list marker
  // (spec/src/map-view.md §The grammar).
  useCanvasProjection({ kind: "all" });

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="lists-page">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-xl font-semibold tracking-tight text-ink">Lists</h1>
        <div className="flex items-center gap-2">
          {creating ? null : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded bg-ink px-3 py-1.5 text-sm font-medium text-white"
              data-testid="new-list"
            >
              + New list
            </button>
          )}
          <Link
            to="/settings"
            hash="import"
            className="rounded border border-rule px-3 py-1.5 text-sm font-medium text-ink-2"
            data-testid="import-entry"
          >
            ⤓ Import
          </Link>
        </div>
      </div>
      {creating ? (
        <div className="mt-3">
          <NewListForm
            lists={lists}
            submitLabel="Create list"
            submitTestId="create-list"
            radioName="lists-page-marker"
            onCreate={(name, marker) => {
              setCreating(false);
              const now = nowIso();
              void repo.createList({ id: newId(), name, marker, createdAt: now, updatedAt: now });
            }}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : null}
      <ul className="mt-4 divide-y divide-land">
        {(previews ?? []).map(({ list, placeCount, postCount, previewNames }) => (
          <li key={list.id} data-testid="list-row">
            <div className="flex items-start gap-3 px-1 py-3 hover:bg-land">
              <MarkerGlyph marker={list.marker} size={20} />
              <div className="min-w-0 flex-1">
                <Link to="/list/$listId" params={{ listId: list.id }} className="block">
                  <span className="font-medium text-ink">{list.name}</span>
                  <span className="ml-2 text-xs text-ink-3" data-testid="list-place-count">
                    {placeCount} {placeCount === 1 ? "place" : "places"}
                  </span>
                </Link>
                {previewNames.length > 0 ? (
                  <p className="mt-0.5 truncate text-xs text-ink-3" data-testid="list-preview">
                    {previewNames.join(" · ")} …
                  </p>
                ) : null}
              </div>
              {postCount > 0 ? (
                <Link
                  to="/list/$listId"
                  params={{ listId: list.id }}
                  hash="posts"
                  className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-water-ink hover:bg-blue-50"
                  data-testid="list-posts-link"
                >
                  ▸ {postCount === 1 ? "post" : `${postCount.toString()} posts`}
                </Link>
              ) : null}
            </div>
          </li>
        ))}
        {previews !== undefined && previews.length === 0 && !creating ? (
          <li className="py-6 text-sm text-ink-3">
            No lists yet. Create one here, or add a place to a new list from its card on the map.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
