/**
 * Create a list: a name — the repository auto-assigns the first free
 * (shape, colour) marker pair (spec/src/data-model.md §Markers); manual
 * marker changes live in list edit mode, swapping within free pairs.
 */
import { useState } from "react";

export interface NewListFormProps {
  submitLabel: string;
  submitTestId: string;
  onCreate: (name: string) => void;
  onCancel: () => void;
}

export function NewListForm({ submitLabel, submitTestId, onCreate, onCancel }: NewListFormProps) {
  const [name, setName] = useState("");

  return (
    <div className="mt-1 flex gap-2">
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
          if (e.key === "Enter" && name.trim() !== "") {
            setName("");
            onCreate(name.trim());
          }
        }}
        className="min-w-0 flex-1 rounded-pill border border-hairline bg-paper px-2 py-1 text-sm text-ink"
      />
      <button
        type="button"
        disabled={name.trim() === ""}
        onClick={() => {
          const trimmed = name.trim();
          if (trimmed === "") return;
          setName("");
          onCreate(trimmed);
        }}
        className="shrink-0 rounded-pill bg-ink px-2 py-1 text-xs font-medium text-paper disabled:opacity-40"
        data-testid={submitTestId}
      >
        {submitLabel}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="shrink-0 rounded-pill px-2 py-1 text-xs text-ink hover:bg-hover"
      >
        Cancel
      </button>
    </div>
  );
}
