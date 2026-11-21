/**
 * The place card (spec/src/map-view.md §The place card): a listing, not a
 * record — photo, name, category · cuisine, the description paragraph (with
 * its Wikipedia credit when the text came from Wikipedia), address, compact
 * fact rows (website, phone, opening hours, wheelchair), then the deep links
 * out, Add to list, and the posts with Write a post. Coordinates never
 * render — the pin on the canvas is the coordinate display. Facts are the
 * user's copy; wrong upstream facts are corrected on OpenStreetMap itself via
 * the OSM link. Opening the card of a place with an `osmRef` fires one
 * fire-and-forget enrichment pass so places added before their facts were
 * captured gain them here.
 *
 * The card is position-agnostic: the composer supplies geometry via
 * `className`. PlaceSheet wraps it as the mobile bottom sheet (dialog
 * semantics); RootLayout composes the desktop column — an <aside> vertical in
 * the shell's row, beside the notebook (spec/src/map-view.md §The grammar).
 */
import type { Post } from "@placemarks/domain";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useLists, usePlaceView, usePostsFor } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { geocoder } from "../../providers";
import { useSelectionStore } from "../../state/projection";
import { usePhotoUrls, usePlaceInsights } from "../insights/hooks";
import { type GalleryPhoto, PhotoGallery } from "../insights/PhotoGallery";
import { PlaceInsightsPanel } from "../insights/PlaceInsightsPanel";
import { AddToList } from "./AddToList";
import { enrichPlace } from "./enrichment";
import { NavLinks } from "./NavLinks";
import { PlaceFacts } from "./PlaceFacts";
import { PlaceImage } from "./PlaceImage";

const NO_PHOTOS: never[] = [];

export function PlaceDetailsSheet({
  placeId,
  variant,
  className,
}: {
  placeId: string;
  /** "sheet": the mobile dialog. "column": the desktop aside in the shell row. */
  variant: "sheet" | "column";
  /** Geometry from the composer; the card owns only content, focus, close. */
  className: string;
}) {
  const repo = useRepo();
  const navigate = useNavigate();
  const clearSelection = useSelectionStore((s) => s.clearSelection);
  const view = usePlaceView(placeId);
  const place = view?.place;
  const lists = useLists();
  const memberListIds = view?.listIds;
  const posts = usePostsFor({ kind: "place", placeId });
  // Classified review insights and harvested photos (spec/src/reviews.md),
  // from the separate insights store; null when the place has none.
  const insights = usePlaceInsights(place);
  const photoUrls = usePhotoUrls(insights?.photos ?? NO_PHOTOS);

  // Managed focus: enter the card once it has actually rendered (the place
  // resolves asynchronously), return to the invoker on close
  // (spec/src/map-view.md §Accessibility and failure).
  const sheetRef = useRef<HTMLElement>(null);
  const focusedOnce = useRef(false);
  const previousFocus = useRef<HTMLElement | null>(null);
  const hasPlace = place !== undefined;
  useEffect(() => {
    if (!hasPlace || focusedOnce.current) return;
    focusedOnce.current = true;
    previousFocus.current = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus();
  }, [hasPlace]);
  useEffect(() => () => previousFocus.current?.focus(), []);

  // Already-added places gain their richer facts the first time their card
  // opens: one best-effort, fire-and-forget enrichment pass
  // (spec/src/map-view.md §The place card). enrichPlace itself skips places
  // without an osmRef, dedups attempts per session, and never throws.
  useEffect(() => {
    if (place?.osmRef === undefined) return;
    void enrichPlace(repo, geocoder, place);
  }, [repo, place]);

  if (!place) return null;

  const gallery: GalleryPhoto[] = (insights?.photos ?? []).map((p) => ({
    id: p.id,
    src: photoUrls.get(p.id) ?? p.url,
    credit: { label: `Photo: ${p.attribution.name}`, href: p.attribution.url },
  }));
  if (place.imageUrl !== undefined) {
    gallery.push({
      id: "wikimedia",
      src: place.imageUrl,
      credit: { label: "Wikimedia Commons", href: place.imageUrl },
    });
  }

  const writePost = () => {
    void repo.createPost({ kind: "place", placeId: place.id }, place.name).then((post) => {
      clearSelection();
      void navigate({ to: "/post/$postId/edit", params: { postId: post.id } });
    });
  };

  // Dialog semantics belong to the mobile sheet only; the desktop column is a
  // labelled aside in the layout, not a modal (spec/src/map-view.md
  // §Accessibility and failure).
  const Wrapper = variant === "sheet" ? "section" : "aside";
  return (
    <Wrapper
      ref={sheetRef}
      tabIndex={-1}
      role={variant === "sheet" ? "dialog" : undefined}
      aria-label={place.name}
      className={`overflow-y-auto bg-paper p-4 ${className}`}
      data-testid="place-details"
    >
      <button
        type="button"
        onClick={clearSelection}
        aria-label="Close"
        className="absolute top-2.5 right-2.5 z-10 flex size-7 items-center justify-center rounded-pill border border-hairline bg-paper text-xs text-ink/70 shadow-lift hover:text-ink"
      >
        ✕
      </button>

      {/* The photo tops the card when the place carries one (spec/src/map-view.md §The place card). */}
      {gallery.length > 1 || (insights?.photos.length ?? 0) > 0 ? (
        <PhotoGallery photos={gallery} name={place.name} />
      ) : place.imageUrl !== undefined ? (
        <PlaceImage url={place.imageUrl} name={place.name} />
      ) : null}

      {/* The listing (spec/src/map-view.md §The place card): name, one muted
          category · cuisine line, then the shared fact block — description,
          address, compact fact rows. No coordinates: the pin is the
          coordinate display. Facts are the user's copy (spec/src/data-model.md). */}
      <h2
        className="pr-8 font-display text-2xl leading-tight font-medium tracking-tight text-ink"
        data-testid="place-name"
      >
        {place.name}
      </h2>
      {place.category || place.cuisine ? (
        <p className="mt-0.5 text-xs capitalize text-ink/70" data-testid="place-category">
          {[place.category, place.cuisine].filter(Boolean).join(" · ")}
        </p>
      ) : null}
      {insights ? <PlaceInsightsPanel source={insights.source} profile={insights.profile} /> : null}
      <PlaceFacts
        description={place.description}
        wikipediaUrl={place.wikipediaUrl}
        creditWikipedia={place.descriptionSource === "wikipedia"}
        address={place.address}
        website={place.website}
        phone={place.phone}
        openingHours={place.openingHours}
        wheelchair={place.wheelchair}
      />

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <NavLinks place={place} />
      </div>

      {/* Add to list — joining a list is how a place enters the library
          (membership is existence, spec/src/data-model.md). */}
      <div className="mt-4">
        <h3 className="eyebrow">Lists</h3>
        <AddToList
          source={{ kind: "existing", placeId: place.id }}
          lists={lists}
          memberListIds={memberListIds ?? []}
          idPrefix="card"
        />
      </div>

      {/* The place's posts, plus Write a post (spec/src/posts.md §Creating). */}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <h3 className="eyebrow">Posts</h3>
          <button
            type="button"
            onClick={writePost}
            className="rounded-pill border border-hairline px-2 py-0.5 text-xs font-medium text-ink"
            data-testid="write-post"
          >
            ✍ Write a post
          </button>
        </div>
        {(posts ?? []).length > 0 ? (
          <ul className="mt-1.5 space-y-1">
            {(posts ?? []).map((post: Post) => (
              <li key={post.id}>
                <button
                  type="button"
                  className="text-sm font-medium text-ink underline"
                  data-testid="place-post-link"
                  onClick={() => {
                    clearSelection();
                    void navigate({ to: "/post/$postId", params: { postId: post.id } });
                  }}
                >
                  {post.title}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Wrapper>
  );
}
