/**
 * Choose the list a new place is born into — an existing one, or one created
 * here. Places do not exist outside lists (spec/src/data-model.md: membership is
 * existence), so every creation path needs this control, which is why it is one
 * component rather than a copy per dialog.
 */
import type { List, ListMarker } from "@placemarks/domain";
import { useState } from "react";
import { suggestMarker } from "../../lib/markers";
import { MarkerSwatches } from "./MarkerSwatches";

export type ListTarget =
  | { kind: "existing"; listId: string }
  | { kind: "new"; name: string; marker: ListMarker };

export interface ListTargetPickerProps {
  lists: List[] | undefined;
  onChange: (target: ListTarget | undefined) => void;
  /** Distinguishes the radio group and test hooks when several exist on a page. */
  idPrefix: string;
}

export function ListTargetPicker({ lists, onChange, idPrefix }: ListTargetPickerProps) {
  const available = lists ?? [];
  const [choice, setChoice] = useState<string>(available.length > 0 ? "" : "__new__");
  const [newListName, setNewListName] = useState("");
  const [marker, setMarker] = useState<ListMarker>();
  const selectedMarker = marker ?? suggestMarker(available);

  const emit = (nextChoice: string, nextName: string, nextMarker: ListMarker) => {
    if (nextChoice === "__new__") {
      onChange(
        nextName.trim() === ""
          ? undefined
          : { kind: "new", name: nextName.trim(), marker: nextMarker },
      );
      return;
    }
    onChange(nextChoice === "" ? undefined : { kind: "existing", listId: nextChoice });
  };

  return (
    <>
      <label className="mt-2 block text-xs font-medium text-ink-2">
        List
        <select
          value={choice}
          onChange={(e) => {
            setChoice(e.target.value);
            emit(e.target.value, newListName, selectedMarker);
          }}
          className="mt-1 w-full rounded border border-rule px-2 py-1.5 text-sm"
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
        <div className="mt-2">
          <input
            type="text"
            value={newListName}
            onChange={(e) => {
              setNewListName(e.target.value);
              emit(choice, e.target.value, selectedMarker);
            }}
            placeholder="New list name"
            aria-label="New list name"
            className="w-full rounded border border-rule px-2 py-1.5 text-sm"
            data-testid={`${idPrefix}-new-list-name`}
          />
          <MarkerSwatches
            radioName={`${idPrefix}-list-marker`}
            selected={selectedMarker}
            used={available.map((l) => l.marker)}
            onSelect={(next) => {
              setMarker(next);
              emit(choice, newListName, next);
            }}
          />
        </div>
      ) : null}
    </>
  );
}
