/**
 * Guide editor + reader: an ordered interleaving of Markdown sections and place
 * blocks (book/src/data-model.md). Zero sections renders as a plain list — the
 * guide structure is opt-in.
 */
import { displayFacts, type GuideBlockView } from "@placemarks/domain";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useGuide, useGuideBlocks, useNotesForPlace, useSavedPlaceViews } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { Markdown } from "../../markdown/Markdown";
import { StateBadge } from "../place/StateBadge";

function AttachNoteSelect({ view }: { view: GuideBlockView }) {
  const repo = useRepo();
  const notes = useNotesForPlace(view.place?.id);
  const attachable = (notes ?? []).filter(
    (n) => n.shareable && !(view.attachments ?? []).some((a) => a.note.id === n.id),
  );
  if (attachable.length === 0) return null;
  return (
    <select
      aria-label="Attach note"
      className="rounded border border-stone-200 px-1 py-0.5 text-xs"
      value=""
      onChange={(e) => {
        if (e.target.value) void repo.attachNoteToBlock(view.block.id, e.target.value, nowIso());
      }}
    >
      <option value="">Attach note…</option>
      {attachable.map((n) => (
        <option key={n.id} value={n.id}>
          {n.title ?? n.body.slice(0, 30)}
        </option>
      ))}
    </select>
  );
}

function BlockCard({
  view,
  editing,
  onMoveUp,
  onMoveDown,
}: {
  view: GuideBlockView;
  editing: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const repo = useRepo();
  const [editingSection, setEditingSection] = useState(false);
  const [draft, setDraft] = useState("");

  const controls = editing ? (
    <span className="flex shrink-0 gap-1">
      <button
        type="button"
        aria-label="Move up"
        onClick={onMoveUp}
        className="rounded px-1.5 text-xs text-stone-500 hover:bg-stone-200"
      >
        ↑
      </button>
      <button
        type="button"
        aria-label="Move down"
        onClick={onMoveDown}
        className="rounded px-1.5 text-xs text-stone-500 hover:bg-stone-200"
      >
        ↓
      </button>
      <button
        type="button"
        aria-label="Remove block"
        onClick={() => void repo.removeBlock(view.block.id, nowIso())}
        className="rounded px-1.5 text-xs text-red-600 hover:bg-red-50"
      >
        ✕
      </button>
    </span>
  ) : null;

  if (view.block.content.type === "section") {
    const note = view.sectionNote;
    return (
      <div className="rounded-lg border border-stone-100 bg-white p-3" data-testid="section-block">
        <div className="flex items-start justify-between gap-2">
          {note?.title ? <h3 className="text-base font-semibold">{note.title}</h3> : null}
          {controls}
        </div>
        {editingSection && note ? (
          <div className="mt-1">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Section body (Markdown)"
              rows={4}
              className="w-full rounded border border-stone-200 p-2 font-mono text-sm"
            />
            <div className="mt-1 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingSection(false)}
                className="rounded px-2 py-0.5 text-xs text-stone-600"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void repo.updateNote({ ...note, body: draft, updatedAt: nowIso() });
                  setEditingSection(false);
                }}
                className="rounded bg-stone-800 px-2 py-0.5 text-xs font-medium text-white"
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-1">
            {note ? <Markdown body={note.body} /> : null}
            {editing && note ? (
              <button
                type="button"
                onClick={() => {
                  setDraft(note.body);
                  setEditingSection(true);
                }}
                className="mt-1 rounded px-1.5 text-xs text-stone-500 hover:bg-stone-200"
              >
                Edit section
              </button>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  const facts = view.place ? displayFacts(view.place) : undefined;
  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 p-3" data-testid="place-block">
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="font-medium text-stone-900">{facts?.name ?? "Missing place"}</span>
          {facts?.category ? (
            <span className="ml-2 text-xs capitalize text-stone-500">{facts.category}</span>
          ) : null}
          {view.place ? (
            <span className="ml-2">
              <StateBadge state={view.place.resolutionState} />
            </span>
          ) : null}
          {facts?.website ? (
            <a
              href={facts.website}
              target="_blank"
              rel="noopener noreferrer nofollow ugc"
              className="block text-sm text-blue-700 underline"
            >
              {facts.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
            </a>
          ) : null}
        </div>
        {controls}
      </div>
      {(view.attachments ?? []).map(({ attachment, note }) => (
        <div key={attachment.id} className="mt-2 rounded border border-stone-100 bg-white p-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-stone-600">{note.title ?? "Note"}</span>
            {editing ? (
              <button
                type="button"
                onClick={() => void repo.detachNoteFromBlock(view.block.id, note.id, nowIso())}
                className="rounded px-1.5 text-xs text-stone-400 hover:bg-stone-100"
              >
                Detach
              </button>
            ) : null}
          </div>
          <Markdown body={note.body} />
        </div>
      ))}
      {editing ? (
        <div className="mt-2">
          <AttachNoteSelect view={view} />
        </div>
      ) : null}
    </div>
  );
}

export function GuidePage() {
  const { listId } = useParams({ from: "/guides/$listId" });
  const repo = useRepo();
  const guide = useGuide(listId);
  const blocks = useGuideBlocks(listId);
  const savedViews = useSavedPlaceViews();
  const [editing, setEditing] = useState(true);
  const [sectionDraft, setSectionDraft] = useState("");

  if (!guide) return <div className="p-4 text-stone-500">Guide not found.</div>;

  const inGuide = new Set(
    (blocks ?? [])
      .filter((v) => v.block.content.type === "place")
      .map((v) => (v.block.content.type === "place" ? v.block.content.savedPlaceId : "")),
  );
  const addable = (savedViews ?? []).filter((v) => !inGuide.has(v.savedPlace.id));

  const move = (index: number, direction: -1 | 1) => {
    const list = blocks ?? [];
    const target = list[index];
    if (!target) return;
    const swapWith = index + direction;
    if (swapWith < 0 || swapWith >= list.length) return;
    const before =
      direction === -1 ? list[swapWith]?.block.id : (list[swapWith + 1]?.block.id ?? null);
    void repo.moveBlock(target.block.id, before ?? null, nowIso());
  };

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="guide-page">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-stone-900">{guide.name}</h1>
        <button
          type="button"
          onClick={() => setEditing((e) => !e)}
          aria-pressed={editing}
          className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700"
          data-testid="toggle-editing"
        >
          {editing ? "Reading view" : "Edit guide"}
        </button>
      </div>
      {guide.description ? (
        <p className="mt-1 text-sm text-stone-600">{guide.description}</p>
      ) : null}

      <div className="mt-4 space-y-3">
        {(blocks ?? []).map((view, index) => (
          <BlockCard
            key={view.block.id}
            view={view}
            editing={editing}
            onMoveUp={() => move(index, -1)}
            onMoveDown={() => move(index, 1)}
          />
        ))}
        {blocks !== undefined && blocks.length === 0 ? (
          <p className="text-sm text-stone-500">
            Empty guide. Add places from the map's place sheet, or write a section below.
          </p>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-4 space-y-3 border-t border-stone-100 pt-3">
          <div>
            <label className="text-xs font-semibold tracking-wide text-stone-500 uppercase">
              Add section
              <textarea
                value={sectionDraft}
                onChange={(e) => setSectionDraft(e.target.value)}
                placeholder="Narrative in Markdown — e.g. ## Morning coffee"
                rows={2}
                className="mt-1 w-full rounded border border-stone-200 p-2 font-mono text-sm font-normal"
                data-testid="section-draft"
              />
            </label>
            <button
              type="button"
              onClick={() => {
                if (sectionDraft.trim() === "") return;
                void repo.addSectionBlock(listId, sectionDraft, nowIso());
                setSectionDraft("");
              }}
              className="mt-1 rounded bg-stone-800 px-2 py-1 text-xs font-medium text-white"
              data-testid="add-section"
            >
              Add section
            </button>
          </div>
          {addable.length > 0 ? (
            <select
              aria-label="Add saved place"
              className="w-full rounded border border-stone-200 px-2 py-1 text-sm"
              value=""
              onChange={(e) => {
                if (e.target.value) void repo.addPlaceBlock(listId, e.target.value, nowIso());
              }}
            >
              <option value="">Add saved place…</option>
              {addable.map((v) => {
                const facts = displayFacts(v.place);
                return (
                  <option key={v.savedPlace.id} value={v.savedPlace.id}>
                    {facts?.name ?? "Unnamed"}
                  </option>
                );
              })}
            </select>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
