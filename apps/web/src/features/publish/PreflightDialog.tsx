/**
 * The publish preview (spec/src/sharing.md §Explicit publish): before anything
 * is sent, the exact disclosure of what leaves the device — the title, the
 * places with their coordinates, and the body — plus the offers to publish
 * linked-but-unpublished posts and a list post's list alongside.
 */
import type { PublishedPlace } from "@placemarks/domain";
import type { ReactNode } from "react";

export interface PreflightOfferOption {
  id: string;
  label: string;
}

export function PreflightDialog({
  heading,
  title,
  places,
  body,
  listRef,
  intro,
  author,
  extra,
  offers,
  checked,
  onToggle,
  busy,
  onConfirm,
  onCancel,
  confirmTestId,
}: {
  heading: string;
  title: string;
  places: readonly PublishedPlace[];
  /** The rewritten Markdown source that leaves the device — posts only. */
  body?: string;
  /** List posts name their list; linked only when the list has a public page. */
  listRef?: { title: string; url?: string };
  /** A list's intro and the curator's name, when they will be published. */
  intro?: string;
  author?: string;
  /** Extra controls over what is shared (a list's notes opt-out). */
  extra?: ReactNode;
  offers: readonly PreflightOfferOption[];
  checked: ReadonlySet<string>;
  onToggle: (id: string) => void;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  confirmTestId: string;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={heading}
      className="w-full rounded-crisp border border-hairline bg-paper p-3 text-xs"
      data-testid="publish-preflight"
    >
      <p className="font-medium text-ink">{heading}</p>
      <p className="mt-1 text-ink" data-testid="preflight-title">
        Title: <span className="font-medium">{title}</span>
      </p>
      {listRef ? (
        <p className="text-ink/70" data-testid="preflight-list-ref">
          Names its list “{listRef.title}”
          {listRef.url
            ? ", linked to its public page"
            : " (name only — the list has no public page)"}
        </p>
      ) : null}
      {author ? (
        <p className="text-ink/70" data-testid="preflight-author">
          Curated by <span className="font-medium text-ink">{author}</span>
        </p>
      ) : null}
      {intro ? (
        <p className="mt-1 whitespace-pre-line text-ink/70" data-testid="preflight-intro">
          Intro: {intro}
        </p>
      ) : null}
      {extra}
      <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-ink/70">
        {places.map((place) => (
          <li key={place.id} data-testid="preflight-place">
            <span className="font-medium text-ink">{place.name}</span> · {String(place.lat)},{" "}
            {String(place.lng)}
            {place.address ? <span className="text-ink/60"> · {place.address}</span> : null}
            {place.note || place.tags?.length || place.rating ? (
              <span className="block text-ink/80" data-testid="preflight-personal">
                {[
                  place.rating ? "★".repeat(place.rating) : undefined,
                  place.tags?.map((tag) => `#${tag}`).join(" "),
                  place.note ? `“${place.note}”` : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            ) : null}
          </li>
        ))}
        {places.length === 0 ? <li className="text-ink/60">No places.</li> : null}
      </ul>
      {body !== undefined ? (
        <pre
          className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap border-l-2 border-hairline pl-2 font-body text-ink/70"
          data-testid="preflight-body"
        >
          {body}
        </pre>
      ) : null}
      {offers.length > 0 ? (
        <fieldset className="mt-2">
          <legend className="text-ink/70">Also publish alongside:</legend>
          {offers.map((offer) => (
            <label key={offer.id} className="mt-1 flex items-center gap-1.5 text-ink/70">
              <input
                type="checkbox"
                checked={checked.has(offer.id)}
                onChange={() => onToggle(offer.id)}
                data-testid="preflight-offer"
                value={offer.id}
              />
              {offer.label}
            </label>
          ))}
        </fieldset>
      ) : null}
      <p className="mt-2 text-[11px] text-ink/60">
        Nothing leaves this device until you press Publish. After that the page is live: later
        changes here update it on their own, and you can switch that off beside the link.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="rounded-pill bg-ink px-2.5 py-1 font-medium text-paper disabled:opacity-40"
          data-testid={confirmTestId}
        >
          Publish
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-pill px-2.5 py-1 text-ink/70 hover:bg-hairline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
