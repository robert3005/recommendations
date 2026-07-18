/** All lists: create + browse. Lists are the primary grouping (book/src/vision.md). */
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useLists } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { newId } from "../../lib/id";
import { nowIso } from "../../lib/time";

export function ListsPage() {
  const repo = useRepo();
  const lists = useLists();
  const [name, setName] = useState("");

  const create = () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    const now = nowIso();
    void repo.createList({ id: newId(), name: trimmed, createdAt: now, updatedAt: now });
    setName("");
  };

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="lists-page">
      <h1 className="text-xl font-semibold text-stone-900">Lists</h1>
      <p className="mt-1 text-sm text-stone-500">Group places together and describe the set.</p>
      <div className="mt-3 flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
          }}
          placeholder="New list, e.g. Lisbon favourites"
          aria-label="New list name"
          className="flex-1 rounded border border-stone-300 px-3 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={create}
          className="rounded bg-stone-800 px-3 py-1.5 text-sm font-medium text-white"
          data-testid="create-list"
        >
          Create
        </button>
      </div>
      <ul className="mt-4 divide-y divide-stone-100">
        {(lists ?? []).map((list) => (
          <li key={list.id}>
            <Link
              to="/lists/$listId"
              params={{ listId: list.id }}
              className="block px-1 py-3 hover:bg-stone-50"
            >
              <span className="font-medium text-stone-900">{list.name}</span>
              {list.description ? (
                <span className="block text-sm text-stone-500">{list.description}</span>
              ) : null}
            </Link>
          </li>
        ))}
        {lists !== undefined && lists.length === 0 ? (
          <li className="py-6 text-sm text-stone-500">
            No lists yet. Create one, then add saved places to it.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
