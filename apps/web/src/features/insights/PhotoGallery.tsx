/**
 * The place card's photo gallery (spec/src/reviews.md §The place card): a
 * 3:2 hero, a strip of thumbnails, and a full-screen lightbox. Every photo
 * carries its credit; a photo that fails to load drops out silently, and the
 * gallery disappears when none are left.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface GalleryPhoto {
  id: string;
  src: string;
  credit: { label: string; href?: string };
}

function Credit({ credit }: { credit: GalleryPhoto["credit"] }) {
  return credit.href ? (
    <a href={credit.href} target="_blank" rel="noopener noreferrer" className="underline">
      {credit.label}
    </a>
  ) : (
    <span>{credit.label}</span>
  );
}

const STRIP = 4;

export function PhotoGallery({ photos, name }: { photos: GalleryPhoto[]; name: string }) {
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState<number>();
  const visible = photos.filter((p) => !failed.has(p.id));
  const fail = useCallback((id: string) => setFailed((s) => new Set(s).add(id)), []);
  if (visible.length === 0) return null;
  const [hero, ...rest] = visible;
  if (!hero) return null;
  const strip = rest.slice(0, STRIP);
  const more = rest.length - strip.length;

  return (
    <figure className="mb-3" data-testid="place-gallery">
      <button
        type="button"
        className="block w-full"
        onClick={() => setOpen(0)}
        aria-label={`Open photos of ${name}`}
      >
        <img
          src={hero.src}
          alt={name}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => fail(hero.id)}
          className="aspect-[3/2] w-full rounded-crisp border border-hairline object-cover"
        />
      </button>
      {strip.length > 0 ? (
        <div className="mt-1 grid grid-cols-4 gap-1" data-testid="place-gallery-strip">
          {strip.map((p, i) => {
            const isLast = i === strip.length - 1 && more > 0;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setOpen(i + 1)}
                className="relative block"
                aria-label={isLast ? `Open all ${visible.length} photos` : `Open photo ${i + 2}`}
              >
                <img
                  src={p.src}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={() => fail(p.id)}
                  className="aspect-square w-full rounded-crisp border border-hairline object-cover"
                />
                {isLast ? (
                  <span className="absolute inset-0 flex items-center justify-center rounded-crisp bg-paper/70 font-mono text-xs text-ink">
                    +{more}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <figcaption
        className="mt-0.5 text-right text-[10px] text-ink/55"
        data-testid="place-gallery-credit"
      >
        <Credit credit={hero.credit} />
      </figcaption>
      {open !== undefined ? (
        <Lightbox
          photos={visible}
          index={open}
          name={name}
          onIndex={setOpen}
          onClose={() => setOpen(undefined)}
        />
      ) : null}
    </figure>
  );
}

function Lightbox({
  photos,
  index,
  name,
  onIndex,
  onClose,
}: {
  photos: GalleryPhoto[];
  index: number;
  name: string;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const photo = photos[Math.min(index, photos.length - 1)];
  const step = useCallback(
    (d: number) => onIndex((index + d + photos.length) % photos.length),
    [index, onIndex, photos.length],
  );
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, step]);
  if (!photo) return null;

  const navClass =
    "rounded-crisp border border-hairline bg-paper px-3 py-1.5 text-sm text-ink hover:bg-ink/10";
  // Portalled to <body> so no ancestor's overflow or stacking context clips it.
  return createPortal(
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`Photos of ${name}`}
      className="fixed inset-0 z-50 flex flex-col bg-paper p-4 outline-none"
      data-testid="place-lightbox"
    >
      <div className="flex items-center justify-between text-sm text-ink/70">
        <span className="font-mono text-xs">
          {index + 1} / {photos.length}
        </span>
        <button type="button" onClick={onClose} aria-label="Close photos" className={navClass}>
          ✕
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center py-3">
        <img
          src={photo.src}
          alt={`${name}, ${index + 1} of ${photos.length}`}
          referrerPolicy="no-referrer"
          className="max-h-full max-w-full rounded-crisp border border-hairline object-contain"
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-ink/70">
        <button
          type="button"
          onClick={() => step(-1)}
          aria-label="Previous photo"
          className={navClass}
          disabled={photos.length < 2}
        >
          ←
        </button>
        <span className="truncate">
          <Credit credit={photo.credit} />
        </span>
        <button
          type="button"
          onClick={() => step(1)}
          aria-label="Next photo"
          className={navClass}
          disabled={photos.length < 2}
        >
          →
        </button>
      </div>
    </div>,
    document.body,
  );
}
