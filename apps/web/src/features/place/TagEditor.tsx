/** Tag chips + input. Tags are reused across places by normalized name. */
import type { Tag } from "@placemarks/domain";
import { useState } from "react";
import { useTags } from "../../data/hooks";

export interface TagEditorProps {
  tags: Tag[];
  onAdd: (name: string) => void;
  onRemove: (tagId: string) => void;
}

export function TagEditor({ tags, onAdd, onRemove }: TagEditorProps) {
  const [draft, setDraft] = useState("");
  const allTags = useTags();
  const suggestions = (allTags ?? []).filter((t) => !tags.some((existing) => existing.id === t.id));

  const submit = () => {
    const name = draft.trim();
    if (name === "") return;
    onAdd(name);
    setDraft("");
  };

  return (
    <div data-testid="tag-editor">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag.id}
            className="inline-flex items-center gap-1 rounded-full bg-stone-200 px-2 py-0.5 text-xs font-medium text-stone-800"
          >
            {tag.name}
            <button
              type="button"
              aria-label={`Remove tag ${tag.name}`}
              onClick={() => onRemove(tag.id)}
              className="text-stone-500 hover:text-stone-900"
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          onBlur={submit}
          placeholder="Add tag…"
          aria-label="Add tag"
          list="tag-suggestions"
          className="w-24 rounded border border-stone-200 px-2 py-0.5 text-xs"
        />
        <datalist id="tag-suggestions">
          {suggestions.map((t) => (
            <option key={t.id} value={t.name} />
          ))}
        </datalist>
      </div>
    </div>
  );
}
