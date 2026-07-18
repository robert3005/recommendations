/** Markdown note editor with live preview, image import, and the shareable flag. */
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
  const [preview, setPreview] = useState(false);
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
    <div className="rounded-xl border border-stone-200 bg-white p-3" data-testid="note-editor">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (optional)"
        aria-label="Note title"
        className="w-full rounded border border-stone-200 px-2 py-1 text-sm font-medium"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPreview(false)}
          aria-pressed={!preview}
          className={`rounded px-2 py-0.5 text-xs font-medium ${!preview ? "bg-stone-800 text-white" : "text-stone-600"}`}
        >
          Write
        </button>
        <button
          type="button"
          onClick={() => setPreview(true)}
          aria-pressed={preview}
          className={`rounded px-2 py-0.5 text-xs font-medium ${preview ? "bg-stone-800 text-white" : "text-stone-600"}`}
        >
          Preview
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="ml-auto rounded border border-stone-300 px-2 py-0.5 text-xs font-medium text-stone-700"
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
      {preview ? (
        <div
          className="mt-2 min-h-24 rounded border border-stone-100 bg-stone-50 p-2"
          data-testid="note-preview"
        >
          <Markdown body={body} />
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-label="Note body (Markdown)"
          placeholder="Write in Markdown — **bold**, lists, tables…"
          rows={6}
          className="mt-2 w-full rounded border border-stone-200 p-2 font-mono text-sm"
        />
      )}
      <label className="mt-2 flex items-center gap-2 text-xs text-stone-600">
        <input
          type="checkbox"
          checked={shareable}
          onChange={(e) => setShareable(e.target.checked)}
        />
        Shareable — may be selected when publishing a guide (off = always private)
      </label>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-3 py-1 text-sm text-stone-600 hover:bg-stone-100"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() =>
            onSave({
              ...note,
              ...(title.trim() ? { title: title.trim() } : {}),
              body,
              mediaIds,
              shareable,
              updatedAt: nowIso(),
            })
          }
          className="rounded bg-stone-800 px-3 py-1 text-sm font-medium text-white"
        >
          Save note
        </button>
      </div>
    </div>
  );
}
