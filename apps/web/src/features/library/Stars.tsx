/**
 * The owner's star rating (spec/src/design.md §Tags): five ink stars, filled
 * in half steps, the unfilled part drawn faint so the scale is always visible.
 */
import { formatStars, STAR_VALUES } from "@placemarks/domain";
import { type KeyboardEvent, type PointerEvent, useState } from "react";

/** One star, filled 0, ½ or whole. */
function StarGlyph({ fill }: { fill: number }) {
  return (
    <span className="relative inline-block" aria-hidden="true">
      <span className="text-ink/20">★</span>
      {fill > 0 ? (
        <span
          className="absolute inset-y-0 left-0 overflow-hidden text-ink"
          style={{ width: `${(fill * 100).toString()}%` }}
        >
          ★
        </span>
      ) : null}
    </span>
  );
}

const fillOf = (stars: number, index: number) => Math.min(1, Math.max(0, stars - index));

export function starsLabel(stars: number): string {
  return `${formatStars(stars)} of 5 stars`;
}

/** A read-only rating, for rows and lists. Nothing when the place is unrated. */
export function RatingStars({ stars }: { stars: number | undefined }) {
  if (!stars) return null;
  return (
    <span
      className="inline-flex shrink-0 font-mono text-xs leading-none text-ink"
      role="img"
      aria-label={`Your rating: ${starsLabel(stars)}`}
      title={starsLabel(stars)}
      data-testid="rating-stars"
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <StarGlyph key={i} fill={fillOf(stars, i)} />
      ))}
    </span>
  );
}

/** Five stars as text — the preflight list's compact form. */
export function starsText(stars: number): string {
  const whole = Math.floor(stars);
  return `${"★".repeat(whole)}${stars > whole ? "½" : ""}`;
}

/**
 * The rating control on the place card. Each star has two halves: tap the
 * left half for a half star, the right for a whole one, and tap the current
 * rating again to clear it. A slider to the keyboard: arrows step by a half,
 * Home / End jump, Delete clears.
 */
export function StarInput({
  stars,
  onChange,
}: {
  stars: number | undefined;
  onChange: (stars: number | null) => void;
}) {
  const [hover, setHover] = useState<number | undefined>(undefined);
  const current = stars ?? 0;
  const shown = hover ?? current;

  const valueAt = (target: EventTarget): number | undefined => {
    const zone = (target as HTMLElement).closest<HTMLElement>("[data-value]");
    return zone ? Number(zone.dataset.value) : undefined;
  };
  const pick = (value: number) => onChange(value === stars ? null : value);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 0.5, ArrowUp: 0.5, ArrowLeft: -0.5, ArrowDown: -0.5 }[
      event.key as "ArrowRight"
    ];
    let next: number | null | undefined;
    if (step !== undefined) next = Math.min(5, Math.max(0, current + step));
    else if (event.key === "Home") next = 0.5;
    else if (event.key === "End") next = 5;
    else if (event.key === "Delete" || event.key === "Backspace") next = 0;
    if (next === undefined) return;
    event.preventDefault();
    if (next !== current) onChange(next === 0 ? null : next);
  };

  return (
    <div className="flex items-center gap-2">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Your rating"
        aria-valuemin={0}
        aria-valuemax={5}
        aria-valuenow={current}
        aria-valuetext={stars ? starsLabel(stars) : "Not rated"}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          const value = valueAt(event.target);
          if (value !== undefined) pick(value);
        }}
        onPointerMove={(event: PointerEvent) => {
          if (event.pointerType === "mouse") setHover(valueAt(event.target));
        }}
        onPointerLeave={() => setHover(undefined)}
        className="-mx-1 flex cursor-pointer touch-manipulation select-none rounded-sm px-1 text-[1.75rem] leading-none outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink sm:text-2xl"
        data-testid="star-input"
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="relative px-px">
            <StarGlyph fill={fillOf(shown, i)} />
            {/* The two hit zones: left half, right half. */}
            <span
              className="absolute inset-y-0 left-0 w-1/2"
              data-value={STAR_VALUES[i * 2]}
              data-testid={`rate-${formatStars(i + 0.5)}`}
              title={starsLabel(i + 0.5)}
            />
            <span
              className="absolute inset-y-0 right-0 w-1/2"
              data-value={STAR_VALUES[i * 2 + 1]}
              data-testid={`rate-${formatStars(i + 1)}`}
              title={starsLabel(i + 1)}
            />
          </span>
        ))}
      </div>
      <span className="min-w-[2.5rem] font-mono text-xs text-ink/70" aria-hidden="true">
        {shown > 0 ? `${formatStars(shown)}/5` : ""}
      </span>
    </div>
  );
}
