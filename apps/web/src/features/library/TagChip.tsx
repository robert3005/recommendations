/**
 * The two kinds of tag, drawn so they can never be mistaken for each other
 * (spec/src/design.md §Tags):
 *
 *  - an OWN tag is the owner's word: a solid ink pill, prefixed "#";
 *  - a DERIVED tag came from other people's reviews: a dashed outline with no
 *    fill, prefixed "✦", and announced as "from reviews".
 *
 * Both can be static labels or toggle buttons (filters); the shape and fill
 * carry the difference, not colour alone.
 */
import { vocabLabel } from "@placemarks/domain";
import type { ReactNode } from "react";

interface ChipProps {
  /** Renders a toggle button when given. */
  onClick?: () => void;
  pressed?: boolean;
  /** A trailing remove control (own tags on the place card). */
  onRemove?: () => void;
  count?: number;
  testId?: string;
}

function Shell({
  className,
  onClick,
  pressed,
  testId,
  title,
  children,
}: {
  className: string;
  onClick?: (() => void) | undefined;
  pressed?: boolean | undefined;
  testId?: string | undefined;
  title?: string;
  children: ReactNode;
}) {
  const cls = `inline-flex max-w-full items-center gap-1 rounded-pill px-2 py-0.5 text-xs ${className}`;
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed ?? false}
      className={cls}
      data-testid={testId}
      title={title}
    >
      {children}
    </button>
  ) : (
    <span className={cls} data-testid={testId} title={title}>
      {children}
    </span>
  );
}

export function OwnTag({
  tag,
  onClick,
  pressed,
  onRemove,
  count,
  testId,
}: ChipProps & { tag: string }) {
  // A filter chip that is not pressed is outlined; a label or pressed chip is solid.
  const solid = onClick === undefined || pressed === true;
  return (
    <Shell
      className={
        solid
          ? "border border-ink bg-ink font-medium text-paper"
          : "border border-ink bg-paper font-medium text-ink hover:bg-hover"
      }
      onClick={onClick}
      pressed={pressed}
      testId={testId ?? "own-tag"}
      title="Your tag"
    >
      <span aria-hidden="true" className="opacity-60">
        #
      </span>
      <span className="truncate">{tag}</span>
      {count !== undefined ? (
        <span className="font-mono text-[10px] opacity-70">{count}</span>
      ) : null}
      {onRemove ? (
        // biome-ignore lint/a11y/useSemanticElements: a button cannot nest inside the toggle button; this is the static-label variant's remove control
        <span
          role="button"
          tabIndex={0}
          aria-label={`Remove tag ${tag}`}
          className="ml-0.5 cursor-pointer opacity-70 hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onRemove();
            }
          }}
        >
          ✕
        </span>
      ) : null}
    </Shell>
  );
}

export function DerivedTag({ tag, onClick, pressed, count, testId }: ChipProps & { tag: string }) {
  return (
    <Shell
      className={`border border-dashed italic ${
        pressed ? "border-ink bg-wash text-ink" : "border-ink/50 text-ink/80"
      } ${onClick ? "hover:bg-hover" : ""}`}
      onClick={onClick}
      pressed={pressed}
      testId={testId ?? "derived-tag"}
      title="From reviews"
    >
      <span aria-hidden="true">✦</span>
      <span className="truncate">{vocabLabel(tag)}</span>
      <span className="sr-only"> (from reviews)</span>
      {count !== undefined ? (
        <span className="font-mono text-[10px] not-italic opacity-70">{count}</span>
      ) : null}
    </Shell>
  );
}

const STAR_LABEL = ["", "Good", "Great", "Favourite"] as const;

export function ratingLabel(rating: number): string {
  return STAR_LABEL[rating] ?? "";
}

/** One to three stars; the rest drawn hollow so the scale is visible. */
export function RatingStars({ rating }: { rating: number | undefined }) {
  if (!rating) return null;
  return (
    <span
      className="font-mono text-xs text-ink"
      role="img"
      aria-label={`Your rating: ${ratingLabel(rating)}`}
      data-testid="rating-stars"
    >
      {"★".repeat(rating)}
      <span className="text-ink/25">{"★".repeat(3 - rating)}</span>
    </span>
  );
}
