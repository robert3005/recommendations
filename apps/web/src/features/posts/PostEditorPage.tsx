/**
 * The post block editor (spec/src/posts.md §Authoring): insert, remove, and
 * reorder prose sections and place embeds — the same rank-based interaction
 * as list Edit mode. Prose opens the full-screen Markdown editor; embeds come
 * from the post's list (browse here) or from the map (the place card offers
 * **Embed in post** while this editor is open). The canvas shows embeds solid
 * with the rest of the post's list dimmed as candidates.
 */
import { displayFacts, type Note, type PostBlockView } from "@placemarks/domain";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useList, useListBlocks, useNotesForPlace, usePost, usePostBlocks } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { useCanvasProjection } from "../../state/projection";
import { useUiStore } from "../../state/ui";
import { NoteEditor } from "../notes/NoteEditor";

/** Attach/select manager for one place embed. */
function EmbedEdges({ view }: { view: PostBlockView }) {
  const repo = useRepo();
  const placeId = view.block.content.type === "place" ? view.block.content.placeId : undefined;
  const notes = useNotesForPlace(placeId);
  const shareable = (notes ?? []).filter((n) => n.shareable);
  const attachedIds = new Set((view.attachments ?? []).map((a) => a.note.id));
  const selectedTagIds = new Set((view.tagSelections ?? []).map((s) => s.tag.id));
  const [error, setError] = useState<string>();
  const place = view.place;
  if (!placeId || !place) return null;
  return (
    <div className="mt-1.5 space-y-1 border-t border-stone-200 pt-1.5 text-xs">
      {shareable.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-stone-500">Attach notes:</span>
          {shareable.map((note) => {
            const attached = attachedIds.has(note.id);
            return (
              <button
                key={note.id}
                type="button"
                aria-pressed={attached}
                data-testid={`attach-note-${note.id}`}
                className={`rounded-full px-2 py-0.5 font-medium ${
                  attached ? "bg-stone-800 text-white" : "bg-stone-200 text-stone-700"
                }`}
                onClick={() => {
                  const action = attached
                    ? repo.detachNoteFromPostBlock(view.block.id, note.id, nowIso())
                    : repo.attachNoteToPostBlock(view.block.id, note.id, nowIso()).then(() => {});
                  action.catch((err: unknown) =>
                    setError(err instanceof Error ? err.message : String(err)),
                  );
                }}
              >
                {note.title ?? "Untitled note"}
              </button>
            );
          })}
        </div>
      ) : null}
      {/* Tags publish only through explicit selection (spec/src/data-model.md). */}
      <TagSelections
        view={view}
        placeId={placeId}
        selectedTagIds={selectedTagIds}
        onError={setError}
      />
      {error ? <p className="text-red-700">{error}</p> : null}
    </div>
  );
}

function TagSelections({
  view,
  placeId,
  selectedTagIds,
  onError,
}: {
  view: PostBlockView;
  placeId: string;
  selectedTagIds: Set<string>;
  onError: (message: string) => void;
}) {
  const repo = useRepo();
  const [tags, setTags] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    repo
      .getPlaceView(placeId)
      .then((placeView) => {
        if (!cancelled && placeView) setTags(placeView.tags);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [repo, placeId]);
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-stone-500">Share tags:</span>
      {tags.map((tag) => {
        const selected = selectedTagIds.has(tag.id);
        return (
          <button
            key={tag.id}
            type="button"
            aria-pressed={selected}
            data-testid={`select-tag-${tag.id}`}
            className={`rounded-full px-2 py-0.5 font-medium ${
              selected ? "bg-stone-800 text-white" : "bg-stone-200 text-stone-700"
            }`}
            onClick={() => {
              const action = selected
                ? repo.deselectTagForPostBlock(view.block.id, tag.id, nowIso())
                : repo.selectTagForPostBlock(view.block.id, tag.id, nowIso()).then(() => {});
              action.catch((err: unknown) =>
                onError(err instanceof Error ? err.message : String(err)),
              );
            }}
          >
            {tag.name}
          </button>
        );
      })}
    </div>
  );
}

export function PostEditorPage() {
  const { postId } = useParams({ from: "/post/$postId/edit" });
  const repo = useRepo();
  const navigate = useNavigate();
  const post = usePost(postId);
  const blocks = usePostBlocks(postId);
  const list = useList(post?.listId);
  const members = useListBlocks(post?.listId);
  const setEmbedTargetPost = useUiStore((s) => s.setEmbedTargetPost);
  const [title, setTitle] = useState<string>();
  const [editingNote, setEditingNote] = useState<Note>();
  const [error, setError] = useState<string>();

  // The canvas: embeds solid, the rest of the post's list dimmed as candidates.
  useCanvasProjection({ kind: "post", postId, editing: true });

  // While this editor is open, tapping a library pin offers "Embed in post"
  // (spec/src/map-view.md §Core interactions).
  useEffect(() => {
    setEmbedTargetPost(postId);
    return () => setEmbedTargetPost(null);
  }, [postId, setEmbedTargetPost]);

  const blockKey = (blocks ?? []).map((view) => view.block.id).join("|");
  useEffect(() => {
    if (!blockKey || !window.location.hash) return;
    const blockId = decodeURIComponent(window.location.hash.slice(1));
    document.getElementById(blockId)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [blockKey]);

  if (!post) return <div className="p-4 text-stone-500">Post not found.</div>;

  const embeddedIds = new Set(
    (blocks ?? []).flatMap((view) =>
      view.block.content.type === "place" ? [view.block.content.placeId] : [],
    ),
  );
  const candidates = (members ?? []).filter((member) => !embeddedIds.has(member.place.id));

  const move = (view: PostBlockView, direction: -1 | 1) => {
    const all = blocks ?? [];
    const index = all.findIndex((v) => v.block.id === view.block.id);
    const target = index + direction;
    if (target < 0 || target >= all.length) return;
    const before =
      direction === -1 ? (all[target]?.block.id ?? null) : (all[target + 1]?.block.id ?? null);
    void repo.movePostBlock(view.block.id, before, nowIso());
  };

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="post-editor">
      <input
        type="text"
        value={title ?? post.title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          const trimmed = title?.trim();
          if (trimmed && trimmed !== post.title) {
            void repo.updatePost({ ...post, title: trimmed, updatedAt: nowIso() });
          }
          setTitle(undefined);
        }}
        aria-label="Post title"
        className="w-full rounded border border-stone-300 px-2 py-1 text-xl font-semibold"
        data-testid="post-title-input"
      />
      <p className="mt-1 text-xs text-stone-500">
        An article about {list?.name ?? "its list"} — prose sections between place embeds. Embeds
        come from the list, or tap a pin on the map and choose “Embed in post”.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded bg-stone-800 px-3 py-1.5 text-sm font-medium text-white"
          data-testid="add-section"
          onClick={() => {
            void repo.addPostSection(postId, "", nowIso()).then(async (block) => {
              if (block.content.type !== "section") return;
              const note = await repo
                .getPostBlocks(postId)
                .then(
                  (views) =>
                    views.find((view) => view.block.id === block.id)?.sectionNote ?? undefined,
                );
              if (note) setEditingNote(note);
            });
          }}
        >
          + Section
        </button>
        {candidates.length > 0 ? (
          <select
            aria-label="Embed a place from the list"
            className="rounded border border-stone-300 px-2 py-1.5 text-sm"
            value=""
            data-testid="embed-picker"
            onChange={(e) => {
              if (!e.target.value) return;
              repo
                .embedPlaceInPost(postId, e.target.value, nowIso())
                .catch((err: unknown) =>
                  setError(err instanceof Error ? err.message : String(err)),
                );
            }}
          >
            <option value="">+ Embed a place…</option>
            {candidates.map((member) => {
              const facts = displayFacts(member.place);
              return (
                <option key={member.place.id} value={member.place.id}>
                  {facts?.name ?? "Unnamed place"}
                </option>
              );
            })}
          </select>
        ) : null}
        <button
          type="button"
          className="ml-auto rounded border border-stone-300 px-3 py-1 text-sm font-medium text-stone-700"
          data-testid="done-editing-post"
          onClick={() => {
            void navigate({ to: "/post/$postId", params: { postId } });
          }}
        >
          Done
        </button>
      </div>
      {error ? (
        <output className="mt-2 block rounded bg-orange-50 p-2 text-xs text-orange-800">
          {error}
        </output>
      ) : null}

      <ul className="mt-4 space-y-2">
        {(blocks ?? []).map((view) => {
          const isSection = view.block.content.type === "section";
          const facts = view.place ? displayFacts(view.place) : undefined;
          return (
            <li
              key={view.block.id}
              id={view.block.id}
              className="rounded-lg border border-stone-200 bg-stone-50 p-3 target:ring-2 target:ring-stone-400"
              data-testid={isSection ? "editor-section" : "editor-embed"}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  {isSection ? (
                    <button
                      type="button"
                      className="block w-full text-left"
                      data-testid="edit-section"
                      onClick={() => view.sectionNote && setEditingNote(view.sectionNote)}
                    >
                      <span className="text-xs font-semibold tracking-wide text-stone-400 uppercase">
                        Section
                      </span>
                      <span className="block truncate text-sm text-stone-800">
                        {view.sectionNote?.title ??
                          (view.sectionNote?.body.trim()
                            ? view.sectionNote.body.slice(0, 80)
                            : "Empty section — tap to write")}
                      </span>
                    </button>
                  ) : (
                    <>
                      <span className="text-xs font-semibold tracking-wide text-stone-400 uppercase">
                        Place
                      </span>
                      <span className="block truncate text-sm font-medium text-stone-900">
                        {facts?.name ?? "Unnamed place"}
                      </span>
                    </>
                  )}
                </div>
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    aria-label="Move up"
                    className="rounded px-1.5 py-0.5 text-xs text-stone-600 hover:bg-stone-200"
                    onClick={() => move(view, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    className="rounded px-1.5 py-0.5 text-xs text-stone-600 hover:bg-stone-200"
                    onClick={() => move(view, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-xs text-red-700 hover:bg-red-50"
                    data-testid="remove-post-block"
                    onClick={() => void repo.removePostBlock(view.block.id, nowIso())}
                  >
                    Remove
                  </button>
                </span>
              </div>
              {!isSection ? <EmbedEdges view={view} /> : null}
            </li>
          );
        })}
        {blocks !== undefined && blocks.length === 0 ? (
          <li className="py-4 text-sm text-stone-500">
            Start with a section, or embed the list's places between passages.
          </li>
        ) : null}
      </ul>

      <button
        type="button"
        className="mt-6 rounded border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
        data-testid="delete-post"
        onClick={() => {
          const listId = post.listId;
          void repo.deletePost(post.id, nowIso()).then(() => {
            void navigate({ to: "/list/$listId", params: { listId } });
          });
        }}
      >
        Delete post
      </button>

      {editingNote ? (
        <NoteEditor
          note={editingNote}
          onSave={(updated) => {
            setEditingNote(undefined);
            void repo.updateNote(updated);
          }}
          onCancel={() => setEditingNote(undefined)}
        />
      ) : null}
    </div>
  );
}
