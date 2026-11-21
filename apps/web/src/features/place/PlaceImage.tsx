/**
 * The place photo block (spec/src/map-view.md §The place card): a ~3:2 crop
 * with a "Wikimedia Commons" credit link — the licensing click-through. The
 * data model guarantees the URL is Wikimedia-hosted. A failed load hides the
 * whole block; no broken-image state ever renders. Used by the place card and
 * the published viewers' place cards alike.
 */
import { useState } from "react";

export function PlaceImage({ url, name }: { url: string; name: string }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  if (failedUrl === url) return null;
  return (
    <figure className="mb-3" data-testid="place-image">
      <img
        src={url}
        alt={name}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(url)}
        className="aspect-[3/2] w-full rounded-crisp border border-hairline object-cover"
      />
      <figcaption className="mt-0.5 text-right text-[10px] text-ink/60">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
          data-testid="place-image-credit"
        >
          Wikimedia Commons
        </a>
      </figcaption>
    </figure>
  );
}
