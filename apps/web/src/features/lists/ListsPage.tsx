/**
 * The Lists tab: browse and edit only (book/src/map-view.md). Lists are created
 * from a place's card — save a place, then add it to a new list there.
 */
import { Link } from "@tanstack/react-router";
import { useLists } from "../../data/hooks";
import { DEFAULT_PIN_COLOR } from "../../lib/markers";

export function ListsPage() {
  const lists = useLists();

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="lists-page">
      <h1 className="text-xl font-semibold text-stone-900">Lists</h1>
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
        {lists !== undefined && lists.length === 0 ? (
          <li className="py-6 text-sm text-stone-500">
            No lists yet. Save a place on the map, then add it to a new list from its card.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
