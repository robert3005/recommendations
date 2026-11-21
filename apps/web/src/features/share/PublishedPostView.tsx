/**
 * `/p/:slug` — the public post page (spec/src/sharing.md §The public viewer):
 * the article in the notebook beside the canvas projecting its places. The
 * body is viewer-mode Markdown — only http/https links and `#` fragments
 * survive its sanitizer — and `#place-<id>` fragments map to pin focus.
 * noindex; ODbL attribution when any place carries an `osmRef`.
 */
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { Markdown } from "../../markdown/Markdown";
import { PlaceFacts } from "../place/PlaceFacts";
import { PlaceImage } from "../place/PlaceImage";
import { placeIdFromHash, usePlaceFragmentSelection } from "./placeFragment";
import { fetchPublishedPost, PublishedDocumentError } from "./publishedDoc";
import { useNoindex } from "./useNoindex";
import { OdblAttribution, OsmPlaceLink, ViewerError, ViewerLoading } from "./viewerChrome";
import { usePublishedDocProjection } from "./viewerProjection";

export function PublishedPostView() {
  const { slug } = useParams({ from: "/p/$slug" });
  return <PublishedPostContent slug={slug} />;
}

function retryUnreachableOnce(failureCount: number, error: unknown): boolean {
  return (
    error instanceof PublishedDocumentError && error.reason === "unreachable" && failureCount < 1
  );
}

export function PublishedPostContent({ slug }: { slug: string }) {
  useNoindex();
  const query = useQuery({
    queryKey: ["published", "post", slug],
    queryFn: ({ signal }) => fetchPublishedPost(slug, signal),
    retry: retryUnreachableOnce,
  });
  const doc = query.data;
  const placeIds = useMemo(() => (doc?.places ?? []).map((place) => place.id), [doc]);
  const [selectedId, select] = usePlaceFragmentSelection(placeIds);
  const docKey = `post:${slug}`;
  usePublishedDocProjection(docKey, doc?.places ?? []);

  if (query.isPending) return <ViewerLoading docKey={docKey} label="Loading shared post…" />;
  if (query.isError) return <ViewerError docKey={docKey} error={query.error} />;
  const document = query.data;

  return (
    <article className="p-4" data-testid="published-post">
      <header>
        <h1 className="font-display text-[1.75rem] leading-tight font-medium tracking-tight text-ink">
          {document.title}
        </h1>
        {document.list ? (
          <p className="mt-1 text-xs text-ink/70" data-testid="published-post-list">
            From the list{" "}
            {document.list.url ? (
              <a href={document.list.url} className="font-medium underline">
                {document.list.title}
              </a>
            ) : (
              <span className="font-medium">{document.list.title}</span>
            )}
          </p>
        ) : null}
      </header>
      <div className="mt-3" data-testid="published-post-body">
        <Markdown
          body={document.body}
          mode="viewer"
          {...(selectedId !== undefined ? { selectedPlaceId: selectedId } : {})}
          onFragmentClick={(fragment) => {
            const placeId = placeIdFromHash(fragment);
            if (placeId !== undefined) select(placeId);
          }}
        />
      </div>
      {document.places.length > 0 ? (
        <section className="mt-5" aria-label="Places in this post">
          <h2 className="eyebrow">Places</h2>
          <ul className="mt-1 space-y-1">
            {document.places.map((place) => (
              <li key={place.id} id={`place-${place.id}`} data-testid="published-place">
                {/* The photo and facts, exactly as published — the same
                    listing the place card renders (spec/src/map-view.md §The
                    place card); no coordinates, the pin is the coordinate
                    display. */}
                {place.imageUrl !== undefined ? (
                  <PlaceImage url={place.imageUrl} name={place.name} />
                ) : null}
                <button
                  type="button"
                  onClick={() => select(place.id)}
                  aria-current={selectedId === place.id ? "true" : undefined}
                  data-selected={selectedId === place.id || undefined}
                  className={`w-full rounded-pill border px-2 py-1 text-left text-xs ${
                    selectedId === place.id ? "border-ink" : "border-hairline"
                  }`}
                >
                  <span className="font-medium text-ink">{place.name}</span>
                  {place.category || place.cuisine ? (
                    <>
                      {" "}
                      <span className="capitalize text-ink/60">
                        {[place.category, place.cuisine].filter(Boolean).join(" · ")}
                      </span>
                    </>
                  ) : null}
                </button>
                <PlaceFacts
                  description={place.description}
                  wikipediaUrl={place.wikipediaUrl}
                  address={place.address}
                  website={place.website}
                  phone={place.phone}
                  openingHours={place.openingHours}
                  wheelchair={place.wheelchair}
                />
                <OsmPlaceLink place={place} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <OdblAttribution places={document.places} />
    </article>
  );
}
