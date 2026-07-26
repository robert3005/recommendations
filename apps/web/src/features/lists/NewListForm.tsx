/**
 * Create a list: a name plus a unique (colour, icon) marker
 * (spec/src/map-view.md). Used directly on the Lists home (2026-07-18: lists
 * can be created in the app, before any place joins them) and inline while
 * adding a place to a new list.
 */
import type { List, ListMarker } from "@placemarks/domain";
import { useState } from "react";
import { suggestMarker } from "../../lib/markers";
import { MarkerSwatches } from "./MarkerSwatches";

export interface NewListFormProps {
  /** Existing lists — the marker defaults to the next unused combination. */
  lists: List[] | undefined;
  submitLabel: string;
  submitTestId: string;
  radioName: string;
  onCreate: (name: string, marker: ListMarker) => void;
  onCancel: () => void;
}

export function NewListForm({
  lists,
  submitLabel,
  submitTestId,
  radioName,
  onCreate,
  onCancel,
}: NewListFormProps) {
  const [name, setName] = useState("");
  const [marker, setMarker] = useState<ListMarker>();
  const selectedMarker = marker ?? suggestMarker(lists ?? []);

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
            if (e.key === "Escape") onCancel();
          }}
          className="min-w-0 flex-1 rounded border border-rule px-2 py-1 text-sm"
        />
        <button
          type="button"
          disabled={name.trim() === ""}
          onClick={() => {
            const trimmed = name.trim();
            if (trimmed === "") return;
            setName("");
            setMarker(undefined);
            onCreate(trimmed, selectedMarker);
          }}
          className="shrink-0 rounded bg-ink px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
          data-testid={submitTestId}
        >
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded px-2 py-1 text-xs text-ink-2 hover:bg-land"
        >
          Cancel
        </button>
      </div>
      <MarkerSwatches
        radioName={radioName}
        selected={selectedMarker}
        used={(lists ?? []).map((l) => l.marker)}
        onSelect={setMarker}
      />
    </div>
  );
}
