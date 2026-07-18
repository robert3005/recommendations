/** Name an unlinked manual pin before saving (book/src/place-identity.md). */
import { useState } from "react";

export interface ManualPinDialogProps {
  lat: number;
  lng: number;
  onSave: (facts: { name: string; lat: number; lng: number; category?: string }) => void;
  onCancel: () => void;
}

export function ManualPinDialog({ lat, lng, onSave, onCancel }: ManualPinDialogProps) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");

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
        aria-label="Save unlinked pin"
        className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={() => {}}
        data-testid="manual-pin-dialog"
      >
        <h2 className="text-base font-semibold text-stone-900">Save as unlinked pin</h2>
        <p className="mt-1 text-xs text-orange-700">
          Owner-provided details, not linked to OpenStreetMap. You can link it later.
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
            disabled={name.trim() === ""}
            onClick={() =>
              onSave({
                name: name.trim(),
                lat,
                lng,
                ...(category.trim() ? { category: category.trim() } : {}),
              })
            }
            className="rounded bg-orange-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            data-testid="manual-save"
          >
            Save pin
          </button>
        </div>
      </div>
    </div>
  );
}
