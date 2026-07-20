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
import { MarkerGlyph } from "./MarkerGlyph";
import { NewListForm } from "./NewListForm";

export function ListsPage() {
  const repo = useRepo();
  const previews = useListPreviews();
  const [creating, setCreating] = useState(false);
  const lists = previews?.map((p) => p.list);

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="lists-page">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-stone-900">Lists</h1>
        <div className="flex items-center gap-2">
          {creating ? null : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded bg-stone-800 px-3 py-1.5 text-sm font-medium text-white"
              data-testid="new-list"
            >
              + New list
            </button>
          )}
          <Link
            to="/settings"
            hash="import"
            className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700"
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
      <ul className="mt-4 divide-y divide-stone-100">
        {(previews ?? []).map(({ list, placeCount, postCount, previewNames }) => (
          <li key={list.id} data-testid="list-row">
            <div className="flex items-start gap-3 px-1 py-3 hover:bg-stone-50">
              <MarkerGlyph marker={list.marker} size={20} />
              <div className="min-w-0 flex-1">
                <Link to="/lists/$listId" params={{ listId: list.id }} className="block">
                  <span className="font-medium text-stone-900">{list.name}</span>
                  <span className="ml-2 text-xs text-stone-500" data-testid="list-place-count">
                    {placeCount} {placeCount === 1 ? "place" : "places"}
                  </span>
                </Link>
                {previewNames.length > 0 ? (
                  <p className="mt-0.5 truncate text-xs text-stone-500" data-testid="list-preview">
                    {previewNames.join(" · ")} …
                  </p>
                ) : null}
              </div>
              {postCount > 0 ? (
                <Link
                  to="/lists/$listId"
                  params={{ listId: list.id }}
                  hash="posts"
                  className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-blue-700 hover:bg-blue-50"
                  data-testid="list-posts-link"
                >
                  ▸ {postCount === 1 ? "post" : `${postCount.toString()} posts`}
                </Link>
              ) : null}
            </div>
          </li>
        ))}
        {previews !== undefined && previews.length === 0 && !creating ? (
          <li className="py-6 text-sm text-stone-500">
            No lists yet. Create one here, or add a place to a new list from its card on the map.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
