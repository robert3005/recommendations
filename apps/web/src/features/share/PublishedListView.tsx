/**
 * `/l/:slug` — the public list page (spec/src/sharing.md §The public viewer):
 * an SPA route that fetches the published document from the share service and
 * renders it read-only in the notebook beside the canvas projecting its
 * places. No live OSM resolution, no import — exactly what was published, as
 * of publish time. noindex by default; ODbL attribution when any place
 * carries an `osmRef`.
 */
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { PlaceFacts } from "../place/PlaceFacts";
import { PlaceImage } from "../place/PlaceImage";
import { usePlaceFragmentSelection } from "./placeFragment";
import { fetchPublishedList, PublishedDocumentError } from "./publishedDoc";
import { useNoindex } from "./useNoindex";
import {
  MarkerGlyph,
  OdblAttribution,
  OsmPlaceLink,
  ViewerError,
  ViewerLoading,
} from "./viewerChrome";
import { usePublishedDocProjection } from "./viewerProjection";

export function PublishedListView() {
  const { slug } = useParams({ from: "/l/$slug" });
  return <PublishedListContent slug={slug} />;
}

/** Only transport failures retry; gone/not-found are answers, not errors. */
function retryUnreachableOnce(failureCount: number, error: unknown): boolean {
  return (
    error instanceof PublishedDocumentError && error.reason === "unreachable" && failureCount < 1
  );
}

export function PublishedListContent({ slug }: { slug: string }) {
  useNoindex();
  const query = useQuery({
    queryKey: ["published", "list", slug],
    queryFn: ({ signal }) => fetchPublishedList(slug, signal),
    retry: retryUnreachableOnce,
  });
  const doc = query.data;
  const placeIds = useMemo(() => (doc?.places ?? []).map((place) => place.id), [doc]);
  const [selectedId, select] = usePlaceFragmentSelection(placeIds);
  const docKey = `list:${slug}`;
  usePublishedDocProjection(docKey, doc?.places ?? [], doc?.marker);

  if (query.isPending) return <ViewerLoading docKey={docKey} label="Loading shared list…" />;
  if (query.isError) return <ViewerError docKey={docKey} error={query.error} />;
  const document = query.data;

  return (
    <article className="p-4" data-testid="published-list">
      <header className="flex items-center gap-2">
        <MarkerGlyph marker={document.marker} />
        <h1 className="font-display text-xl text-ink">{document.title}</h1>
      </header>
      {document.posts && document.posts.length > 0 ? (
        <nav aria-label="Posts about this list" className="mt-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink/55">Posts</h2>
          <ul className="mt-1 space-y-1">
            {document.posts.map((post) => (
              <li key={post.url}>
                <a
                  href={post.url}
                  className="text-sm text-ink underline"
                  data-testid="published-list-post"
                >
                  {post.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <ul className="mt-4 space-y-2">
        {document.places.map((place) => (
          <li key={place.id} id={`place-${place.id}`} data-testid="published-place">
            <div
              className={`rounded-crisp border px-2 py-1.5 ${
                selectedId === place.id ? "border-ink" : "border-hairline"
              }`}
              data-selected={selectedId === place.id || undefined}
            >
              {/* The photo and facts, exactly as published — the same listing
                  the place card renders (spec/src/map-view.md §The place
                  card); no coordinates, the pin is the coordinate display. */}
              {place.imageUrl !== undefined ? (
                <PlaceImage url={place.imageUrl} name={place.name} />
              ) : null}
              <button
                type="button"
                onClick={() => select(place.id)}
                aria-current={selectedId === place.id ? "true" : undefined}
                className="block w-full text-left"
              >
                <span className="text-sm font-medium text-ink">{place.name}</span>
                {place.category || place.cuisine ? (
                  <span className="block text-xs capitalize text-ink/70">
                    {[place.category, place.cuisine].filter(Boolean).join(" · ")}
                  </span>
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
            </div>
          </li>
        ))}
      </ul>
      {document.places.length === 0 ? (
        <p className="mt-4 text-sm text-ink/55">This list was published empty.</p>
      ) : null}
      <OdblAttribution places={document.places} />
    </article>
  );
}
