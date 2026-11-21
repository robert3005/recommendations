/**
 * Shared chrome for the public viewer pages: loading and failure states (a
 * revoked or unknown slug gets a designed message, never a blank page), the
 * marker glyph, and the ODbL attribution that appears exactly when any
 * published place carries an `osmRef` (spec/src/sharing.md §The public viewer).
 */
import { type ListMarker, MARKER_SHAPE_PATHS, osmElementUrl } from "@placemarks/domain";
import type { PublishedPlace } from "@placemarks/schemas";
import { PublishedDocumentError } from "./publishedDoc";
import { EmptyPublishedDocProjection } from "./viewerProjection";

/** Rendered straight from the domain shape table so pins and rows never diverge. */
export function MarkerGlyph({ marker }: { marker: ListMarker }) {
  return (
    <svg viewBox="0 0 30 30" className="h-5 w-5 shrink-0" aria-hidden="true">
      <path d={MARKER_SHAPE_PATHS[marker.shape]} fill={marker.color} />
    </svg>
  );
}

export function ViewerLoading({ docKey, label }: { docKey: string; label: string }) {
  return (
    <>
      <EmptyPublishedDocProjection docKey={docKey} />
      <p className="p-6 text-sm text-ink/60">{label}</p>
    </>
  );
}

export function ViewerError({ docKey, error }: { docKey: string; error: unknown }) {
  const reason = error instanceof PublishedDocumentError ? error.reason : "unreachable";
  const heading =
    reason === "gone"
      ? "This page is no longer available."
      : reason === "not-found"
        ? "There is nothing at this link."
        : "Could not load this page.";
  const detail =
    reason === "gone"
      ? "Its author unpublished it, and an unpublished link is gone for good."
      : reason === "not-found"
        ? "Check the link — published pages live under /l/ and /p/."
        : "The share service is unreachable — try again shortly.";
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyPublishedDocProjection docKey={docKey} />
      <p
        className="max-w-sm text-center text-sm text-ink/70"
        data-testid="published-error"
        data-reason={reason}
      >
        <span className="font-semibold text-ink">{heading}</span> {detail}
      </p>
    </div>
  );
}

export function OdblAttribution({ places }: { places: readonly PublishedPlace[] }) {
  if (!places.some((place) => place.osmRef !== undefined)) return null;
  return (
    <p className="mt-6 text-[11px] text-ink/60" data-testid="odbl-attribution">
      Includes place data from{" "}
      <a
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noopener noreferrer"
        className="underline"
      >
        © OpenStreetMap contributors
      </a>{" "}
      (ODbL).
    </p>
  );
}

/** The OSM element page — the deep link the document carries the ref for. */
export function OsmPlaceLink({ place }: { place: PublishedPlace }) {
  if (!place.osmRef) return null;
  return (
    <a
      href={osmElementUrl(place.osmRef)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[11px] text-ink/60 underline"
    >
      OpenStreetMap
    </a>
  );
}
