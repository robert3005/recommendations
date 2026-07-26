/**
 * Add a place to a list — or create the list right here. The place card is the
 * write surface for list membership (spec/src/map-view.md); lists themselves can
 * also be created on the Lists tab. Used by both the unsaved place sheet (where
 * adding implies saving) and the saved-place sheet.
 */
import type { List, ListMarker } from "@placemarks/domain";
import { useState } from "react";
import { MarkerGlyph } from "../lists/MarkerGlyph";
import { NewListForm } from "../lists/NewListForm";

export type AddToListTarget =
  | { kind: "existing"; list: List }
  | { kind: "new"; name: string; marker: ListMarker };

export interface AddToListProps {
  lists: List[] | undefined;
  memberListIds: string[];
  onPick: (target: AddToListTarget) => void;
}

export function AddToList({ lists, memberListIds, onPick }: AddToListProps) {
  const [creating, setCreating] = useState(false);
  const currentLists = (lists ?? []).filter((list) => memberListIds.includes(list.id));

  if (creating) {
    return (
      <div>
        <CurrentLists lists={currentLists} />
        <NewListForm
          lists={lists}
          submitLabel="Create & add"
          submitTestId="create-list-and-add"
          radioName="list-marker"
          onCreate={(name, marker) => {
            setCreating(false);
            onPick({ kind: "new", name, marker });
          }}
          onCancel={() => setCreating(false)}
        />
      </div>
    );
  }

  return (
    <div>
      <CurrentLists lists={currentLists} />
      <select
        aria-label="Add to list"
        className="mt-1 w-full rounded border border-rule px-2 py-1 text-sm"
        value=""
        data-testid="add-to-list"
        onChange={(e) => {
          const value = e.target.value;
          if (value === "__new__") {
            setCreating(true);
            return;
          }
          const list = (lists ?? []).find((l) => l.id === value);
          if (list) onPick({ kind: "existing", list });
        }}
      >
        <option value="">Add to list…</option>
        {(lists ?? [])
          .filter((l) => !memberListIds.includes(l.id))
          .map((list) => (
            <option key={list.id} value={list.id}>
              {list.name}
            </option>
          ))}
        <option value="__new__">+ New list…</option>
      </select>
    </div>
  );
}

function CurrentLists({ lists }: { lists: List[] }) {
  if (lists.length === 0) return null;
  return (
    <ul
      className="mb-1 flex flex-wrap gap-1.5 text-xs text-ink-2"
      aria-label="Current lists"
      data-testid="current-list-memberships"
    >
      {lists.map((list) => (
        <li
          key={list.id}
          className="inline-flex items-center gap-1 rounded-full bg-land px-2 py-0.5"
        >
          <MarkerGlyph marker={list.marker} size={12} />
          {list.name}
        </li>
      ))}
    </ul>
  );
}
