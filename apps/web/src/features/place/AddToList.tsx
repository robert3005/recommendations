/**
 * Add a place to a list — or create the list right here (book/src/map-view.md:
 * the place card is the only write surface for lists). Used by both the unsaved
 * place sheet (where adding implies saving) and the saved-place sheet.
 */
import type { List } from "@placemarks/domain";
import { useState } from "react";
import { MARKER_COLORS, nextUnusedColor } from "../../lib/markers";

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
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>();

  if (creating) {
    const selectedColor = color ?? nextUnusedColor(lists ?? []);
    return (
      <div className="mt-1">
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New list name"
            aria-label="New list name"
            // biome-ignore lint/a11y/noAutofocus: the input appears on explicit user intent
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Escape") setCreating(false);
            }}
            className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
          />
          <button
            type="button"
            disabled={name.trim() === ""}
            onClick={() => {
              const trimmed = name.trim();
              if (trimmed === "") return;
              setCreating(false);
              setName("");
              setColor(undefined);
              onPick({ kind: "new", name: trimmed, color: selectedColor });
            }}
            className="shrink-0 rounded bg-stone-800 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
            data-testid="create-list-and-add"
          >
            Create & add
          </button>
          <button
            type="button"
            onClick={() => setCreating(false)}
            className="shrink-0 rounded px-2 py-1 text-xs text-stone-600 hover:bg-stone-100"
          >
            Cancel
          </button>
        </div>
        {/* The list's visual marker — its places wear this colour on the map. */}
        <div className="mt-2 flex items-center gap-1.5" role="radiogroup" aria-label="List marker">
          {MARKER_COLORS.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={option === selectedColor}
              aria-label={`Marker colour ${option}`}
              onClick={() => setColor(option)}
              className={`h-5 w-5 rounded-full border-2 ${
                option === selectedColor ? "border-stone-800" : "border-transparent"
              }`}
              style={{ backgroundColor: option }}
              data-testid={`marker-${option}`}
            />
          ))}
        </div>
      </div>
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
