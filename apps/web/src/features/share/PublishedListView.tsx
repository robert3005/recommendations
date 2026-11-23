/**
 * `/l/:slug` — the public list page (spec/src/sharing.md §The public viewer):
 * an SPA route that fetches the published document from the share service and
 * renders it read-only in the notebook beside the canvas projecting its
 * places. No live OSM resolution, no import — exactly what was published, as
 * of publish time. noindex by default; ODbL attribution when any place
 * carries an `osmRef`.
 */

import { placeKindLine, starsFromLegacyRating } from "@placemarks/domain";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { RatingStars } from "../library/Stars";
import { OwnTag } from "../library/TagChip";
import { NavLinks } from "../place/NavLinks";
import { PlaceFacts } from "../place/PlaceFacts";
import { PlaceImage } from "../place/PlaceImage";
import { usePlaceFragmentSelection } from "./placeFragment";
import { fetchPublishedList, PublishedDocumentError } from "./publishedDoc";
import { useNoindex } from "./useNoindex";
import { MarkerGlyph, OdblAttribution, ViewerError, ViewerLoading } from "./viewerChrome";
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
    // A shared list is live (spec/src/sharing.md §Live pages): an open page
    // picks up the curator's next version on its own — on return to the tab
    // and, while it stays open, about once a minute (the service's cache window).
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
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
        <h1 className="font-display text-[2.25rem] leading-none font-semibold tracking-tight text-ink">
          {document.title}
        </h1>
      </header>
      {document.author || document.version ? (
        <p className="mt-2 font-mono text-[11px] text-ink/60" data-testid="published-byline">
          {[
            document.author ? `Curated by ${document.author}` : undefined,
            document.places.length > 0
              ? `${document.places.length.toString()} ${document.places.length === 1 ? "place" : "places"}`
              : undefined,
            document.version ? `v${document.version.toString()}` : undefined,
            document.updatedAt
              ? `updated ${new Date(document.updatedAt).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}`
              : undefined,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      {document.description ? (
        <p
          className="mt-3 font-body text-sm leading-relaxed whitespace-pre-line text-ink/90"
          data-testid="published-intro"
        >
          {document.description}
        </p>
      ) : null}
      {document.posts && document.posts.length > 0 ? (
        <nav aria-label="Posts about this list" className="mt-3">
          <h2 className="eyebrow">Posts</h2>
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
                <span className="flex items-baseline gap-2">
                  <span className="font-display text-base font-semibold text-ink">
                    {place.name}
                  </span>
                  <RatingStars stars={place.stars ?? starsFromLegacyRating(place.rating)} />
                </span>
                {placeKindLine(place) !== "" ? (
                  <span className="block text-xs text-ink/70">{placeKindLine(place)}</span>
                ) : null}
              </button>
              {/* The curator's voice comes before the provider's facts. */}
              {place.note ? (
                <p
                  className="mt-1.5 border-l-2 border-ink pl-2 font-body text-sm leading-relaxed text-ink"
                  data-testid="published-note"
                >
                  {place.note}
                </p>
              ) : null}
              {place.tags?.length ? (
                <p className="mt-1.5 flex flex-wrap gap-1" data-testid="published-tags">
                  {place.tags.map((tag) => (
                    <OwnTag key={tag} tag={tag} />
                  ))}
                </p>
              ) : null}
              <PlaceFacts
                description={place.description}
                wikipediaUrl={place.wikipediaUrl}
                address={place.address}
                website={place.website}
                phone={place.phone}
                openingHours={place.openingHours}
                wheelchair={place.wheelchair}
              />
              {/* A recommendation is for going there: the same deep links the
                  owner's card hands out. */}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <NavLinks place={place} />
              </div>
            </div>
          </li>
        ))}
      </ul>
      {document.places.length === 0 ? (
        <p className="mt-4 text-sm text-ink/60">This list was published empty.</p>
      ) : null}
      <OdblAttribution places={document.places} />
    </article>
  );
}
