/**
 * Full-screen Markdown note editor (spec/src/map-view.md): a writing surface
 * with a live sanitized preview. Markdown source is what gets persisted
 * (spec/src/notes.md — Markdown is the source of truth).
 */
import type { Note } from "@placemarks/domain";
import { useRef, useState } from "react";
import { useRepo } from "../../data/RepoContext";
import { newId } from "../../lib/id";
import { nowIso } from "../../lib/time";
import { Markdown } from "../../markdown/Markdown";
import { importImage } from "./importImage";

export interface NoteEditorProps {
  note: Note;
  onSave: (note: Note) => void;
  onCancel: () => void;
}

export function NoteEditor({ note, onSave, onCancel }: NoteEditorProps) {
  const repo = useRepo();
  const [title, setTitle] = useState(note.title ?? "");
  const [body, setBody] = useState(note.body);
  const [shareable, setShareable] = useState(note.shareable);
  const [mediaIds, setMediaIds] = useState(note.mediaIds);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const insertImage = async (file: File) => {
    const imported = await importImage(file);
    if (!imported) return;
    const asset = {
      id: newId(),
      mime: imported.mime,
      ...(imported.width ? { width: imported.width } : {}),
      ...(imported.height ? { height: imported.height } : {}),
      localBlobKey: newId(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    } as const;
    await repo.putMedia(asset, imported.blob);
    setMediaIds((ids) => [...ids, asset.id]);
    const snippet = `\n![${file.name.replace(/\.[a-z0-9]+$/i, "")}](asset:${asset.id})\n`;
    const textarea = textareaRef.current;
    if (textarea) {
      const at = textarea.selectionStart ?? body.length;
      setBody((current) => current.slice(0, at) + snippet + current.slice(at));
    } else {
      setBody((current) => current + snippet);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-white"
      role="dialog"
      aria-modal="true"
      aria-label="Edit note"
      data-testid="note-editor"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-stone-200 px-4 py-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-1 text-sm text-stone-600 hover:bg-stone-100"
        >
          Cancel
        </button>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Note title (optional)"
          aria-label="Note title"
          className="min-w-0 flex-1 rounded border border-transparent px-2 py-1 text-base font-medium focus:border-stone-300 focus:outline-none"
        />
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-stone-600">
          <input
            type="checkbox"
            checked={shareable}
            onChange={(e) => setShareable(e.target.checked)}
          />
          Shareable
        </label>
        <button
          type="button"
          onClick={() => {
            // The title is optional: spreading `note` would resurrect a cleared one.
            const { title: _previous, ...rest } = note;
            onSave({
              ...rest,
              ...(title.trim() ? { title: title.trim() } : {}),
              body,
              mediaIds,
              shareable,
              updatedAt: nowIso(),
            });
          }}
          className="shrink-0 rounded bg-stone-800 px-3 py-1.5 text-sm font-medium text-white"
        >
          Save note
        </button>
      </header>
      <div className="grid min-h-0 flex-1 grid-rows-2 md:grid-cols-2 md:grid-rows-1">
        <div className="flex min-h-0 flex-col border-b border-stone-200 md:border-r md:border-b-0">
          <div className="flex shrink-0 items-center justify-between px-4 pt-2">
            <span className="text-[11px] font-semibold tracking-wide text-stone-400 uppercase">
              Markdown
            </span>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="rounded border border-stone-200 px-2 py-0.5 text-xs font-medium text-stone-600 hover:bg-stone-100"
            >
              Add image
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              aria-label="Import image"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void insertImage(file);
                e.target.value = "";
              }}
            />
          </div>
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            aria-label="Note body (Markdown)"
            placeholder={"Write in Markdown — **bold**, lists, tables, images…"}
            className="min-h-0 flex-1 resize-none p-4 font-mono text-sm focus:outline-none"
          />
        </div>
        <div className="min-h-0 overflow-y-auto p-4" data-testid="note-preview">
          <span className="text-[11px] font-semibold tracking-wide text-stone-400 uppercase">
            Preview
          </span>
          <div className="mt-2">
            {body.trim() === "" ? (
              <p className="text-sm text-stone-400">Nothing to preview yet.</p>
            ) : (
              <Markdown body={body} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
