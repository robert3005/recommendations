/**
 * Add a place to a list — or create the list right here. The place card is the
 * write surface for list membership (book/src/map-view.md); lists themselves can
 * also be created on the Lists tab. Used by both the unsaved place sheet (where
 * adding implies saving) and the saved-place sheet.
 */
import type { List } from "@placemarks/domain";
import { useState } from "react";
import { NewListForm } from "../lists/NewListForm";

export type AddToListTarget =
  | { kind: "existing"; list: List }
  | { kind: "new"; name: string; color: string };

export interface AddToListProps {
  lists: List[] | undefined;
  memberListIds: string[];
  onPick: (target: AddToListTarget) => void;
}

export function AddToList({ lists, memberListIds, onPick }: AddToListProps) {
  const [creating, setCreating] = useState(false);

  if (creating) {
    return (
      <NewListForm
        lists={lists}
        submitLabel="Create & add"
        submitTestId="create-list-and-add"
        radioName="list-marker"
        onCreate={(name, color) => {
          setCreating(false);
          onPick({ kind: "new", name, color });
        }}
        onCancel={() => setCreating(false)}
      />
    );
  }

  return (
    <select
      aria-label="Add to list"
      className="mt-1 w-full rounded border border-stone-200 px-2 py-1 text-sm"
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
  );
}
