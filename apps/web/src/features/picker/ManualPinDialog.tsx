/**
 * Name an unlinked manual pin and choose its list — places don't exist outside
 * lists (book/src/data-model.md: membership is existence), so the pin is born
 * into one: an existing list or a new one created here.
 */
import type { List } from "@placemarks/domain";
import { useState } from "react";
import { nextUnusedColor } from "../../lib/markers";
import { MarkerSwatches } from "../lists/MarkerSwatches";

export type ManualPinListTarget =
  | { kind: "existing"; listId: string }
  | { kind: "new"; name: string; color: string };

export interface ManualPinDialogProps {
  lat: number;
  lng: number;
  lists: List[] | undefined;
  onSave: (
    facts: { name: string; lat: number; lng: number; category?: string },
    listTarget: ManualPinListTarget,
  ) => void;
  onCancel: () => void;
}

export function ManualPinDialog({ lat, lng, lists, onSave, onCancel }: ManualPinDialogProps) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [listChoice, setListChoice] = useState<string>((lists ?? []).length > 0 ? "" : "__new__");
  const [newListName, setNewListName] = useState("");
  const [color, setColor] = useState<string>();

  const selectedColor = color ?? nextUnusedColor(lists ?? []);
  const listTarget: ManualPinListTarget | undefined =
    listChoice === "__new__"
      ? newListName.trim() !== ""
        ? { kind: "new", name: newListName.trim(), color: selectedColor }
        : undefined
      : listChoice !== ""
        ? { kind: "existing", listId: listChoice }
        : undefined;
  const canSave = name.trim() !== "" && listTarget !== undefined;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss is supplementary; the Cancel button is the accessible path
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 p-4"
      role="presentation"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add unlinked pin to a list"
        className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={() => {}}
        data-testid="manual-pin-dialog"
      >
        <h2 className="text-base font-semibold text-stone-900">Add unlinked pin</h2>
        <p className="mt-1 text-xs text-orange-700">
          Owner-provided details, not linked to OpenStreetMap. The pin lives in the list you choose
          — you can link it to OSM later.
        </p>
        <label className="mt-3 block text-xs font-medium text-stone-600">
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Our picnic bench"
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
            data-testid="manual-name"
          />
        </label>
        <label className="mt-2 block text-xs font-medium text-stone-600">
          Category (optional)
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g. viewpoint"
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="mt-2 block text-xs font-medium text-stone-600">
          List
          <select
            value={listChoice}
            onChange={(e) => setListChoice(e.target.value)}
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
            data-testid="manual-list-choice"
          >
            <option value="">Choose a list…</option>
            {(lists ?? []).map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
            <option value="__new__">+ New list…</option>
          </select>
        </label>
        {listChoice === "__new__" ? (
          <div className="mt-2">
            <input
              type="text"
              value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
              placeholder="New list name"
              aria-label="New list name"
              className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
              data-testid="manual-new-list-name"
            />
            <MarkerSwatches
              radioName="manual-list-marker"
              selected={selectedColor}
              onSelect={setColor}
            />
          </div>
        ) : null}
        <p className="mt-2 text-xs text-stone-400">
          at {lat.toFixed(5)}, {lng.toFixed(5)}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => {
              if (!listTarget) return;
              onSave(
                {
                  name: name.trim(),
                  lat,
                  lng,
                  ...(category.trim() ? { category: category.trim() } : {}),
                },
                listTarget,
              );
            }}
            className="rounded bg-orange-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            data-testid="manual-save"
          >
            Add pin
          </button>
        </div>
      </div>
    </div>
  );
}
