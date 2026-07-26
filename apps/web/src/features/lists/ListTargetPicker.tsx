/**
 * Pick the list a place joins — an existing one, or one created here by name
 * (the repository auto-assigns its marker). Every add path ends in "pick a
 * list" because membership is existence (spec/src/data-model.md), which is why
 * this is one component rather than a copy per dialog.
 */
import type { List } from "@placemarks/domain";
import { useState } from "react";

export type ListTarget = { kind: "existing"; listId: string } | { kind: "new"; name: string };

export interface ListTargetPickerProps {
  lists: List[] | undefined;
  onChange: (target: ListTarget | undefined) => void;
  /** Distinguishes controls and test hooks when several exist on a page. */
  idPrefix: string;
  /** Lists the place already belongs to — not offered again. */
  excludeListIds?: string[];
}

export function ListTargetPicker({
  lists,
  onChange,
  idPrefix,
  excludeListIds = [],
}: ListTargetPickerProps) {
  const available = (lists ?? []).filter((list) => !excludeListIds.includes(list.id));
  const [choice, setChoice] = useState<string>(available.length > 0 ? "" : "__new__");
  const [newListName, setNewListName] = useState("");

  const emit = (nextChoice: string, nextName: string) => {
    if (nextChoice === "__new__") {
      onChange(nextName.trim() === "" ? undefined : { kind: "new", name: nextName.trim() });
      return;
    }
    onChange(nextChoice === "" ? undefined : { kind: "existing", listId: nextChoice });
  };

  return (
    <>
      <label className="mt-2 block text-xs font-medium text-ink">
        List
        <select
          value={choice}
          onChange={(e) => {
            setChoice(e.target.value);
            emit(e.target.value, newListName);
          }}
          className="mt-1 w-full rounded-crisp border border-hairline bg-paper px-2 py-1.5 text-sm text-ink"
          data-testid={`${idPrefix}-list-choice`}
        >
          <option value="">Choose a list…</option>
          {available.map((list) => (
            <option key={list.id} value={list.id}>
              {list.name}
            </option>
          ))}
          <option value="__new__">+ New list…</option>
        </select>
      </label>
      {choice === "__new__" ? (
        <input
          type="text"
          value={newListName}
          onChange={(e) => {
            setNewListName(e.target.value);
            emit(choice, e.target.value);
          }}
          placeholder="New list name"
          aria-label="New list name"
          className="mt-2 w-full rounded-crisp border border-hairline bg-paper px-2 py-1.5 text-sm text-ink"
          data-testid={`${idPrefix}-new-list-name`}
        />
      ) : null}
    </>
  );
}
