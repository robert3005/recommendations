/**
 * The post reading page (spec/src/posts.md §Reading): the article in the
 * content pane, the post's embeds on the persistent canvas wearing its list's
 * marker. The map FOLLOWS the article — scrolling to a section or embed
 * frames its places (instant recenter under prefers-reduced-motion, handled
 * by the canvas) — and selection links text ↔ pin in both directions.
 */
import { displayFacts } from "@placemarks/domain";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useList, usePost, usePostBlocks } from "../../data/hooks";
import { Markdown } from "../../markdown/Markdown";
import { useCanvasProjection, useProjectionStore } from "../../state/projection";
import { useUiStore } from "../../state/ui";
import { MarkerGlyph } from "../lists/MarkerGlyph";
import { NavLinks } from "../place/NavLinks";
import { PostPublishControls } from "../publish/PostPublishControls";
import { articleFollowGroups } from "./articleFollow";
import { useVisibleFollowKeys } from "./useVisibleFollowKeys";

export function PostPage() {
  const { postId } = useParams({ from: "/post/$postId" });
  const post = usePost(postId);
  const blocks = usePostBlocks(postId);
  const list = useList(post?.listId);
  const selectPlace = useUiStore((s) => s.selectPlace);
  const requestFlyTo = useUiStore((s) => s.requestFlyTo);
  const navigate = useNavigate();

  // The camera follows both prose and embeds. A prose block owns the
  // consecutive embeds that follow it up to the next prose block.
  const [selectedEmbed, setSelectedEmbed] = useState<string>();
  const articleRef = useRef<HTMLDivElement>(null);
  const embedRefs = useRef(new Map<string, HTMLElement>());
  const followGroups = useMemo(
    () =>
      articleFollowGroups(
        (blocks ?? []).map((view) => ({
          blockId: view.block.id,
          ...(view.block.content.type === "place" && view.place ? { placeId: view.place.id } : {}),
        })),
      ),
    [blocks],
  );
  const followKey = [...followGroups.entries()]
    .map(([blockId, placeIds]) => `${blockId}:${placeIds.join(",")}`)
    .join("|");
  const visibleEmbeds = useVisibleFollowKeys({
    rootRef: articleRef,
    attribute: "data-post-follow",
    groups: followGroups,
    groupsKey: followKey,
  });

  const setPostSelectHandler = useProjectionStore((state) => state.setPostSelectHandler);
  const selectFromMap = useCallback((placeId: string) => {
    const entry = embedRefs.current.get(placeId);
    if (!entry) return;
    setSelectedEmbed(placeId);
    entry.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);
  useEffect(() => {
    setPostSelectHandler(selectFromMap);
    return () => setPostSelectHandler(null);
  }, [selectFromMap, setPostSelectHandler]);

  useCanvasProjection({
    kind: "post",
    postId,
    ...(visibleEmbeds.length > 0 ? { focusPlaceIds: visibleEmbeds } : {}),
  });

  if (!post) return <div className="p-4 text-stone-500">Post not found.</div>;

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="post-page" ref={articleRef}>
      <div className="flex items-start justify-between gap-2">
        <h1 className="text-2xl font-semibold text-stone-900">{post.title}</h1>
        <button
          type="button"
          className="shrink-0 rounded border border-stone-300 px-3 py-1 text-sm font-medium text-stone-700"
          data-testid="edit-post"
          onClick={() => {
            void navigate({ to: "/post/$postId/edit", params: { postId: post.id } });
          }}
        >
          Edit
        </button>
      </div>
      {list ? (
        <p className="mt-1 text-sm text-stone-500">
          From the list:{" "}
          <Link
            to="/list/$listId"
            params={{ listId: list.id }}
            className="inline-flex items-center gap-1 font-medium text-blue-700 underline"
            data-testid="post-list-link"
          >
            <MarkerGlyph marker={list.marker} size={14} />
            {list.name}
          </Link>
        </p>
      ) : null}
      <PostPublishControls postId={post.id} />

      <div className="mt-4 space-y-5">
        {(blocks ?? []).map((view) => {
          if (view.block.content.type === "section") {
            const note = view.sectionNote;
            if (!note) return null;
            return (
              <section
                key={view.block.id}
                data-testid="post-section"
                data-post-follow={view.block.id}
              >
                {note.title ? (
                  <h2 className="mb-1 text-lg font-semibold text-stone-900">{note.title}</h2>
                ) : null}
                <Markdown body={note.body} />
              </section>
            );
          }
          const place = view.place;
          const facts = place ? displayFacts(place) : undefined;
          if (!place || !facts) return null;
          return (
            <section
              key={view.block.id}
              ref={(element) => {
                if (element) embedRefs.current.set(place.id, element);
                else embedRefs.current.delete(place.id);
              }}
              data-testid="post-embed"
              data-embed-place={place.id}
              data-post-follow={view.block.id}
              data-selected={selectedEmbed === place.id ? "true" : "false"}
              className={`rounded-lg border bg-stone-50 p-3 ${
                selectedEmbed === place.id
                  ? "border-stone-500 ring-2 ring-stone-300"
                  : "border-stone-200"
              }`}
            >
              {/* Selection is bidirectional: the embed card selects and flies. */}
              <button
                type="button"
                className="text-left text-base font-semibold text-stone-900 hover:underline"
                data-testid="post-embed-select"
                onClick={() => {
                  setSelectedEmbed(place.id);
                  selectPlace(place.id);
                  requestFlyTo({ lat: facts.lat, lng: facts.lng, zoom: 16 });
                }}
              >
                {facts.name ?? "Place"}
              </button>
              {facts.category ? (
                <span className="ml-2 text-xs text-stone-500 capitalize">{facts.category}</span>
              ) : null}
              {facts.address ? <p className="text-sm text-stone-600">{facts.address}</p> : null}
              {(view.attachments ?? []).map(({ attachment, note }) => (
                <div key={attachment.id} className="mt-2 border-t border-stone-200 pt-2 text-sm">
                  {note.title ? <p className="font-medium text-stone-800">{note.title}</p> : null}
                  <Markdown body={note.body} />
                </div>
              ))}
              <div className="mt-2">
                <NavLinks
                  lat={facts.lat}
                  lng={facts.lng}
                  {...(facts.name ? { name: facts.name } : {})}
                  {...(() => {
                    const preferred =
                      place.externalRefs?.find((ref) => ref.provider === "google-maps") ??
                      place.externalRefs?.[0];
                    return preferred?.url ? { externalUrl: preferred.url } : {};
                  })()}
                />
              </div>
            </section>
          );
        })}
        {blocks !== undefined && blocks.length === 0 ? (
          <p className="py-6 text-sm text-stone-500">
            Nothing here yet — open Edit to write sections and embed places from{" "}
            {list?.name ?? "the list"}.
          </p>
        ) : null}
      </div>
    </div>
  );
}
