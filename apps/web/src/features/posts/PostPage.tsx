/**
 * The post reading view (spec/src/posts.md §Reading): the rendered article in
 * the notebook, the canvas projecting the post's places — a list post its
 * list's members, a place post its one place. Selection links text and pins
 * both ways: a mention click focuses the canvas; a pin tap scrolls the
 * article to that place's mention. Cross-post links navigate to the target
 * post's own reading view.
 */
import type { Place } from "@placemarks/domain";
import { extractPostLinkIds, postTargetKey } from "@placemarks/domain";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRepo } from "../../data/RepoContext";
import { Markdown } from "../../markdown/Markdown";
import { editorBridge } from "../../state/editorBridge";
import { useCanvasProjection, useSelectionStore } from "../../state/projection";
import { PublishControls } from "../publish/PublishControls";
import { mentionElementFor } from "./articleFollow";

export function PostPage() {
  const { postId } = useParams({ from: "/post/$postId" });
  const repo = useRepo();
  const navigate = useNavigate();
  const focusPlace = useSelectionStore((s) => s.focusPlace);

  const post = useLiveQuery(() => repo.getPost(postId), [repo, postId]);
  const targetKey = post ? postTargetKey(post.target) : undefined;
  const list = useLiveQuery(
    () => (post && post.target.kind === "list" ? repo.getList(post.target.listId) : undefined),
    [repo, targetKey],
  );
  // The projection rule, one rule on all surfaces: the target's places.
  const places = useLiveQuery(async (): Promise<Place[] | undefined> => {
    if (!post) return undefined;
    if (post.target.kind === "place") {
      const place = await repo.getPlace(post.target.placeId);
      return place ? [place] : [];
    }
    const rows = await repo.entriesOf(post.target.listId);
    return rows.map((row) => row.place);
  }, [repo, targetKey]);

  const bodyKey = post?.body ?? "";
  // Cross-post links are soft: only targets that still exist render as links.
  const knownPostIds = useLiveQuery(async () => {
    const found = await Promise.all(extractPostLinkIds(bodyKey).map((id) => repo.getPost(id)));
    return new Set(found.flatMap((p) => (p ? [p.id] : [])));
  }, [repo, bodyKey]);

  const placesById = useMemo(
    () => new Map((places ?? []).map((place) => [place.id, place])),
    [places],
  );
  const placeIds = useMemo(() => new Set(placesById.keys()), [placesById]);

  useCanvasProjection({ kind: "post", postId });

  const [selectedPlaceId, setSelectedPlaceId] = useState<string>();
  const articleRef = useRef<HTMLDivElement>(null);

  // Mention → pin: focus the canvas on the mentioned place.
  const onPlaceClick = useCallback(
    (id: string) => {
      const place = placesById.get(id);
      if (!place) return;
      setSelectedPlaceId(id);
      focusPlace(id);
    },
    [placesById, focusPlace],
  );

  // Pin → mention: scroll the article to the place's mention.
  const onPinTap = useCallback((id: string) => {
    setSelectedPlaceId(id);
    const root = articleRef.current;
    if (!root) return;
    mentionElementFor(root, id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);
  useEffect(() => editorBridge.register(onPinTap), [onPinTap]);

  const onPostClick = useCallback(
    (id: string) => {
      void navigate({ to: "/post/$postId", params: { postId: id } });
    },
    [navigate],
  );

  if (!post) return <div className="p-4 text-ink/60">Post not found.</div>;

  const targetPlace =
    post.target.kind === "place" ? placesById.get(post.target.placeId) : undefined;

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="post-page">
      <div className="flex items-start justify-between gap-2">
        <h1 className="font-display text-[2.5rem] leading-none font-semibold tracking-tight text-ink">
          {post.title}
        </h1>
        <button
          type="button"
          className="shrink-0 rounded border border-hairline px-3 py-1 text-sm font-medium text-ink"
          data-testid="edit-post"
          onClick={() => {
            void navigate({ to: "/post/$postId/edit", params: { postId: post.id } });
          }}
        >
          Edit
        </button>
      </div>

      {post.target.kind === "list" && list ? (
        <p className="mt-1 text-sm text-ink/60">
          From the list:{" "}
          <Link
            to="/list/$listId"
            params={{ listId: list.id }}
            className="font-medium text-ink underline"
            data-testid="post-list-link"
          >
            {list.name}
          </Link>
        </p>
      ) : null}
      {targetPlace ? (
        <p className="mt-1 text-sm text-ink/60">
          About:{" "}
          <button
            type="button"
            className="font-medium text-ink underline"
            data-testid="post-place-link"
            onClick={() => onPlaceClick(targetPlace.id)}
          >
            {targetPlace.name}
          </button>
        </p>
      ) : null}

      <PublishControls target={{ kind: "post", id: post.id }} />

      <div ref={articleRef} className="mt-4" data-testid="post-article">
        {post.body.trim() ? (
          <Markdown
            body={post.body}
            placeIds={placeIds}
            postIds={knownPostIds ?? new Set()}
            selectedPlaceId={selectedPlaceId}
            onPlaceClick={onPlaceClick}
            onPostClick={onPostClick}
          />
        ) : (
          <p className="py-6 text-sm text-ink/60">
            Nothing here yet — open Edit to write the article.
          </p>
        )}
      </div>
    </div>
  );
}
