/**
 * Add a place from a pasted map link.
 *
 * The point of this screen: OSM search quality trails Google's in many regions,
 * so making our own search better is not the answer. Let whoever sent you the
 * link do the finding — a Google, Apple or OpenStreetMap URL is enough to keep
 * the place, without a Google API and without a Takeout archive.
 *
 * An OSM element link is the good case: it resolves to real copied evidence, so
 * the place is OSM-bound from birth. A Google or Apple link carries coordinates
 * and usually a name, which makes an import-origin place with the URL retained
 * as provenance and as the deep link back.
 */
import type { List } from "@placemarks/domain";
import { useEffect, useRef, useState } from "react";
import type { ParsedPlaceLink } from "../interop/placeLinks";
import { linkIsActionable } from "../interop/placeLinks";
import { type ListTarget, ListTargetPicker } from "../lists/ListTargetPicker";

const PROVIDER_LABEL: Record<ParsedPlaceLink["provider"], string> = {
  "google-maps": "Google Maps",
  openstreetmap: "OpenStreetMap",
  "apple-maps": "Apple Maps",
};

export interface AddFromLinkDialogProps {
  link: ParsedPlaceLink;
  lists: List[] | undefined;
  /** Resolving an OSM element can fail or be offline; the dialog reports it. */
  error?: string;
  busy?: boolean;
  /** `name` is what the owner confirmed — links do not always carry one. */
  onAdd: (name: string, target: ListTarget) => void;
  onCancel: () => void;
}

export function AddFromLinkDialog({
  link,
  lists,
  error,
  busy,
  onAdd,
  onCancel,
}: AddFromLinkDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);

  const [name, setName] = useState(link.name ?? "");
  const [target, setTarget] = useState<ListTarget>();
  const actionable = linkIsActionable(link);
  const canAdd = actionable && name.trim() !== "" && target !== undefined && !busy;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss is supplementary; Cancel is the accessible path
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4"
      role="presentation"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Add a place from a link"
        className="w-full max-w-sm rounded-2xl bg-paper p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={() => {}}
        data-testid="add-from-link-dialog"
      >
        <h2 className="font-display text-base font-semibold text-ink">Add from link</h2>
        <p className="mt-1 font-mono text-[11px] tracking-wide text-ink-3 uppercase">
          {PROVIDER_LABEL[link.provider]}
        </p>

        {link.needsExpansion ? (
          <p className="mt-3 rounded border-l-2 border-amber bg-amber-wash p-2 text-xs text-clay-ink">
            This is a shortened share link, which the browser cannot follow. Open it once in Google
            Maps, then copy the full address bar URL and paste that instead.
          </p>
        ) : !actionable ? (
          <p className="mt-3 rounded border-l-2 border-amber bg-amber-wash p-2 text-xs text-clay-ink">
            This link does not carry a location. Open it in the map app, make sure a specific place
            is selected, then copy the URL again.
          </p>
        ) : (
          <>
            {link.osmRef ? (
              <p className="mt-3 rounded border-l-2 border-leaf bg-leaf-wash p-2 text-xs text-leaf-ink">
                This link names an OpenStreetMap {link.osmRef.type}, so the place arrives with its
                real details — name, address, hours where OSM has them.
              </p>
            ) : (
              <p className="mt-3 text-xs text-ink-2">
                Saved with the link kept, so “Open in {PROVIDER_LABEL[link.provider]}” reopens
                exactly this listing.
              </p>
            )}

            <label className="mt-3 block text-xs font-medium text-ink-2">
              Name
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={link.osmRef ? "Confirm or override" : "e.g. Cervejaria Ramiro"}
                className="mt-1 w-full rounded border border-rule px-2 py-1.5 text-sm"
                data-testid="link-name"
              />
            </label>

            <ListTargetPicker lists={lists} onChange={setTarget} idPrefix="link" />

            {link.coords ? (
              <p className="mt-2 font-mono text-[11px] text-ink-3">
                at {link.coords.lat.toFixed(5)}, {link.coords.lng.toFixed(5)}
              </p>
            ) : null}
          </>
        )}

        {error ? (
          <p className="mt-2 text-xs text-coral-ink" data-testid="link-error">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-sm text-ink-2 hover:bg-land"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canAdd}
            onClick={() => target && onAdd(name.trim(), target)}
            className="rounded bg-leaf px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            data-testid="link-add"
          >
            {busy ? "Adding…" : "Add to list"}
          </button>
        </div>
      </div>
    </div>
  );
}
