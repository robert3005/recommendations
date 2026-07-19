/**
 * The Lists tab: read your lists — and create one (2026-07-18: lists can be
 * created directly in the app, before any place joins them). List contents stay
 * read-only here; places join from their cards (spec/src/map-view.md).
 */
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useLists } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { newId } from "../../lib/id";
import { DEFAULT_PIN_COLOR } from "../../lib/markers";
import { nowIso } from "../../lib/time";
import { NewListForm } from "./NewListForm";

export function ListsPage() {
  const repo = useRepo();
  const lists = useLists();
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="lists-page">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-stone-900">Lists</h1>
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
      </div>
      {creating ? (
        <div className="mt-3">
          <NewListForm
            lists={lists}
            submitLabel="Create list"
            submitTestId="create-list"
            radioName="lists-page-marker"
            onCreate={(name, color) => {
              setCreating(false);
              const now = nowIso();
              void repo.createList({ id: newId(), name, color, createdAt: now, updatedAt: now });
            }}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : null}
      <ul className="mt-4 divide-y divide-stone-100">
        {(lists ?? []).map((list) => (
          <li key={list.id}>
            <Link
              to="/lists/$listId"
              params={{ listId: list.id }}
              className="block px-1 py-3 hover:bg-stone-50"
            >
              <span
                className="mr-2 inline-block h-3 w-3 rounded-full align-baseline"
                style={{ backgroundColor: list.color ?? DEFAULT_PIN_COLOR }}
                data-testid="list-marker"
                data-color={list.color ?? DEFAULT_PIN_COLOR}
              />
              <span className="font-medium text-stone-900">{list.name}</span>
            </Link>
          </li>
        ))}
        {lists !== undefined && lists.length === 0 && !creating ? (
          <li className="py-6 text-sm text-stone-500">
            No lists yet. Create one here, or add a place to a new list from its card on the map.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
