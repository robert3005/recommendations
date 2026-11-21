/**
 * The post editor (spec/src/posts.md §Authoring): a title field and one
 * Markdown body textarea beside the canvas projecting the post's places. The
 * map is the palette the article is written from — tapping a pin inserts a
 * mention at the cursor (via the editor bridge). **Insert post link** opens a
 * picker — for a list post, the place posts of the list's members first, then
 * other posts. **Preview** renders the sanitised article in place, through
 * the same pipeline as the reading view.
 */
import type { Post } from "@placemarks/domain";
import { extractPostLinkIds, postTargetKey } from "@placemarks/domain";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRepo } from "../../data/RepoContext";
import { Markdown } from "../../markdown/Markdown";
import { editorBridge } from "../../state/editorBridge";
import { useCanvasProjection } from "../../state/projection";

const AUTOSAVE_MS = 600;

/** Link text is authored Markdown — keep brackets and backslashes literal. */
function escapeLinkText(text: string): string {
  return text.replace(/([\\[\]])/g, "\\$1");
}

function afterPaint(fn: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
  else setTimeout(fn, 0);
}

export function PostEditorPage() {
  const { postId } = useParams({ from: "/post/$postId/edit" });
  const repo = useRepo();
  const navigate = useNavigate();

  const post = useLiveQuery(() => repo.getPost(postId), [repo, postId]);
  const targetKey = post ? postTargetKey(post.target) : undefined;

  // The projection rule: the editor writes from the target's places.
  const places = useLiveQuery(async () => {
    if (!post) return undefined;
    if (post.target.kind === "place") {
      const place = await repo.getPlace(post.target.placeId);
      return place ? [place] : [];
    }
    const rows = await repo.entriesOf(post.target.listId);
    return rows.map((row) => row.place);
  }, [repo, targetKey]);
  const placesById = useMemo(
    () => new Map((places ?? []).map((place) => [place.id, place])),
    [places],
  );
  const placeIds = useMemo(() => new Set(placesById.keys()), [placesById]);
  const placesByIdRef = useRef(placesById);
  placesByIdRef.current = placesById;

  useCanvasProjection({ kind: "post", postId });

  const [title, setTitle] = useState<string>();
  const [draft, setDraft] = useState<string>();
  const [preview, setPreview] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string>();

  const body = draft ?? post?.body ?? "";
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Debounced autosave; the flush below covers unmount and Done.
  useEffect(() => {
    if (!post || draft === undefined || draft === post.body) return;
    const timer = setTimeout(() => {
      void repo.updatePost(post.id, { body: draft });
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [repo, post, draft]);

  const pendingRef = useRef<{ id: string; body: string } | null>(null);
  pendingRef.current =
    post && draft !== undefined && draft !== post.body ? { id: post.id, body: draft } : null;
  useEffect(
    () => () => {
      if (pendingRef.current) {
        void repo.updatePost(pendingRef.current.id, { body: pendingRef.current.body });
      }
    },
    [repo],
  );

  const insertAtCursor = useCallback((text: string) => {
    const el = textareaRef.current;
    const base = bodyRef.current;
    const start = el?.selectionStart ?? base.length;
    const end = el?.selectionEnd ?? start;
    setDraft(base.slice(0, start) + text + base.slice(end));
    if (el) {
      afterPaint(() => {
        el.focus();
        const caret = start + text.length;
        el.setSelectionRange(caret, caret);
      });
    }
  }, []);

  // Pin to mention (spec/src/map-view.md §The post editor): while the
  // textarea is live, a tapped pin becomes a mention at the cursor.
  const onPinTap = useCallback(
    (tappedPlaceId: string) => {
      const place = placesByIdRef.current.get(tappedPlaceId);
      if (!place) return; // the editor only offers projected pins
      insertAtCursor(`[${escapeLinkText(place.name)}](place:${tappedPlaceId})`);
    },
    [insertAtCursor],
  );
  const placesLoaded = places !== undefined;
  useEffect(() => {
    if (preview) return;
    // A pin cannot exist before the projection's places have loaded, so the
    // bridge registers only once they have — a tap can never race the query.
    if (!placesLoaded) return;
    return editorBridge.register(onPinTap);
  }, [preview, placesLoaded, onPinTap]);

  // Insert-post-link picker: place posts of the list's members first.
  const pickerGroups = useLiveQuery(async () => {
    if (!post) return undefined;
    const placeOf = (p: Post) => (p.target.kind === "place" ? p.target.placeId : undefined);
    const others = (await repo.allPosts()).filter((p) => p.id !== post.id);
    if (post.target.kind !== "list") {
      return { memberPosts: [] as Post[], otherPosts: others };
    }
    const rows = await repo.entriesOf(post.target.listId);
    const memberOrder = new Map(rows.map((row, index) => [row.place.id, index]));
    const rank = (p: Post) => {
      const placeId = placeOf(p);
      return placeId !== undefined ? memberOrder.get(placeId) : undefined;
    };
    const memberPosts = others
      .filter((p) => rank(p) !== undefined)
      .sort((a, b) => (rank(a) ?? 0) - (rank(b) ?? 0) || a.title.localeCompare(b.title));
    const memberPostIds = new Set(memberPosts.map((p) => p.id));
    return { memberPosts, otherPosts: others.filter((p) => !memberPostIds.has(p.id)) };
  }, [repo, targetKey, postId]);

  // Preview resolves links exactly as the reading view would.
  const knownPostIds = useLiveQuery(async () => {
    const found = await Promise.all(extractPostLinkIds(body).map((id) => repo.getPost(id)));
    return new Set(found.flatMap((p) => (p ? [p.id] : [])));
  }, [repo, body]);

  if (!post) return <div className="p-4 text-ink/60">Post not found.</div>;

  const insertPostLink = (target: Post) => {
    insertAtCursor(`[${escapeLinkText(target.title)}](post:${target.id})`);
    setPickerOpen(false);
  };

  const finishEditing = async () => {
    if (draft !== undefined && draft !== post.body) {
      await repo.updatePost(post.id, { body: draft });
      pendingRef.current = null;
    }
    void navigate({ to: "/post/$postId", params: { postId } });
  };

  const deletePost = () => {
    const target = post.target;
    repo
      .deletePost(post.id)
      .then(() => {
        if (target.kind === "list") {
          void navigate({ to: "/list/$listId", params: { listId: target.listId } });
        } else {
          void navigate({ to: "/" });
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  const pickerGroup = (label: string, posts: Post[]) =>
    posts.length > 0 ? (
      <>
        <p className="px-2 pt-2 pb-1 eyebrow">{label}</p>
        <ul>
          {posts.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="block w-full px-2 py-1 text-left text-sm text-ink hover:bg-hairline"
                data-testid={`post-link-option-${p.id}`}
                onClick={() => insertPostLink(p)}
              >
                {p.title}
              </button>
            </li>
          ))}
        </ul>
      </>
    ) : null;

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="post-editor">
      <input
        type="text"
        value={title ?? post.title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          const trimmed = title?.trim();
          if (trimmed && trimmed !== post.title) {
            void repo.updatePost(post.id, { title: trimmed });
          }
          setTitle(undefined);
        }}
        aria-label="Post title"
        className="w-full rounded-pill border border-hairline px-2 py-1 font-display text-xl font-semibold"
        data-testid="post-title-input"
      />
      <p className="mt-1 text-xs text-ink/60">
        Tap a pin on the map to mention that place at the cursor.
      </p>

      <div className="relative mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded-pill border border-hairline px-3 py-1.5 text-sm font-medium text-ink"
          data-testid="insert-post-link"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((open) => !open)}
        >
          Insert post link
        </button>
        <button
          type="button"
          className="rounded-pill border border-hairline px-3 py-1.5 text-sm font-medium text-ink aria-pressed:bg-ink aria-pressed:text-paper"
          data-testid="toggle-preview"
          aria-pressed={preview}
          onClick={() => setPreview((value) => !value)}
        >
          Preview
        </button>
        <button
          type="button"
          className="ml-auto rounded-pill bg-ink px-3 py-1.5 text-sm font-medium text-paper"
          data-testid="done-editing-post"
          onClick={() => void finishEditing()}
        >
          Done
        </button>

        {pickerOpen ? (
          <div
            className="absolute top-full left-0 z-10 mt-1 max-h-64 w-72 overflow-y-auto rounded-crisp border border-hairline bg-panel shadow-lift"
            data-testid="post-link-picker"
          >
            {pickerGroups &&
            pickerGroups.memberPosts.length === 0 &&
            pickerGroups.otherPosts.length === 0 ? (
              <p className="px-2 py-2 text-sm text-ink/60">No other posts to link yet.</p>
            ) : (
              <>
                {pickerGroup("This list's places", pickerGroups?.memberPosts ?? [])}
                {pickerGroup("Other posts", pickerGroups?.otherPosts ?? [])}
              </>
            )}
          </div>
        ) : null}
      </div>

      {error ? (
        <output className="mt-2 block rounded-crisp border border-hairline bg-paper p-2 text-xs text-ink">
          {error}
        </output>
      ) : null}

      {preview ? (
        <div className="mt-3 rounded-crisp border border-hairline p-3" data-testid="post-preview">
          <Markdown body={body} placeIds={placeIds} postIds={knownPostIds ?? new Set()} />
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Post body (Markdown)"
          placeholder="Write in Markdown. Tap a pin to mention a place."
          className="mt-3 min-h-[50vh] w-full resize-y rounded-crisp border border-hairline p-3 font-mono text-sm leading-relaxed"
          data-testid="post-body-input"
        />
      )}

      <button
        type="button"
        className="mt-6 rounded-pill border border-hairline px-3 py-1.5 text-sm font-medium text-ink"
        data-testid="delete-post"
        onClick={deletePost}
      >
        Delete post
      </button>
    </div>
  );
}
