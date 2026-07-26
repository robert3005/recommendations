/**
 * The add-a-place field (spec/src/map-view.md §The add-a-place field): one
 * field, two behaviours. Paste a Google Maps / Apple Maps / OSM URL — parsed,
 * never fetched; `maps.app.goo.gl` short links ask for the expanded URL — or
 * type to search: text in, geocoder results out, pick one. Both paths end in
 * "pick a list", because membership is existence (spec/src/data-model.md).
 *
 * The field lives in the notebook's top bar (2026-07-26 — search-first
 * chrome): a compact single-line input whose results, notices, and the
 * confirm card all open as a floating panel below the header — nothing here
 * may grow the header row.
 *
 * An OSM element URL is the one network call at paste time: the geocoder's
 * exact `lookup` fetches that element's facts. Offline it fails politely —
 * nothing queues; the user retries online (spec/src/interop.md).
 */
import type { GeocoderCandidate, OsmRef, Place } from "@placemarks/domain";
import { parsePastedLink } from "@placemarks/domain";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useLists } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import type { NewPlaceFacts } from "../../data/repo";
import { geocoder } from "../../providers";
import { useSelectionStore } from "../../state/projection";
import { AddToList } from "../place/AddToList";

type Pending =
  | { mode: "notice"; text: string }
  | { mode: "lookup"; ref: OsmRef }
  | { mode: "lookup-error"; ref: OsmRef; message: string }
  | { mode: "confirm"; facts: Omit<NewPlaceFacts, "name">; suggestedName?: string };

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface AddPlaceFieldProps {
  /** Bias search toward the current viewport when the caller has one. */
  bias?: { lat: number; lng: number };
}

export function AddPlaceField({ bias }: AddPlaceFieldProps) {
  const repo = useRepo();
  const lists = useLists();
  // Select AND fly in one call (spec/src/map-view.md §Selection is bidirectional).
  const focusPlace = useSelectionStore((s) => s.focusPlace);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pending, setPending] = useState<Pending>();
  const [name, setName] = useState("");
  const debouncedQuery = useDebounced(query.trim(), 250);
  const listboxId = useId();

  const searchQuery = useQuery({
    queryKey: ["geocode", debouncedQuery, bias?.lat, bias?.lng],
    queryFn: () => geocoder.search(debouncedQuery, bias),
    enabled: debouncedQuery.length >= 2,
    placeholderData: (prev) => prev,
  });
  const results: GeocoderCandidate[] = debouncedQuery.length >= 2 ? (searchQuery.data ?? []) : [];

  const confirmFacts = (facts: Omit<NewPlaceFacts, "name">, suggestedName?: string) => {
    setPending({ mode: "confirm", facts, ...(suggestedName ? { suggestedName } : {}) });
    setName(suggestedName ?? "");
  };

  /** The one paste-time network call: exact facts for a pasted OSM element. */
  const lookupOsm = async (ref: OsmRef) => {
    setPending({ mode: "lookup", ref });
    try {
      const candidate = await geocoder.lookup(ref);
      if (!candidate) throw new Error("no such element");
      confirmFacts(
        {
          lat: candidate.lat,
          lng: candidate.lng,
          ...(candidate.address ? { address: candidate.address } : {}),
          origin: "osm",
          osmRef: ref,
          ...(candidate.imageUrl ? { imageUrl: candidate.imageUrl } : {}),
        },
        candidate.name,
      );
    } catch {
      setPending({
        mode: "lookup-error",
        ref,
        message: "Could not reach OpenStreetMap to look this up. Try again when you are online.",
      });
    }
  };

  /**
   * Add-time enrichment (spec/src/map-view.md §The place card): a search pick
   * carries an osmRef but no element tags, so after a successful add one exact
   * lookup fills a missing photo or address. Best-effort only — a failure or
   * being offline changes nothing, and nothing queues.
   */
  const enrichSearchPick = (place: Place, ref: OsmRef) => {
    geocoder
      .lookup(ref)
      .then((candidate) => {
        if (!candidate) return;
        const patch = {
          ...(candidate.imageUrl !== undefined && place.imageUrl === undefined
            ? { imageUrl: candidate.imageUrl }
            : {}),
          ...(candidate.address !== undefined && place.address === undefined
            ? { address: candidate.address }
            : {}),
        };
        if (Object.keys(patch).length === 0) return;
        return repo.updatePlaceFacts(place.id, patch);
      })
      .catch(() => {
        // Silent by design: enrichment never surfaces an error.
      });
  };

  /** Returns true when the input was taken as a map link. */
  const takeLink = (raw: string): boolean => {
    const parsed = parsePastedLink(raw);
    if (!parsed) return false;
    if (parsed.kind === "short-link") {
      // Reveals nothing without following a redirect — ask, never fetch.
      setPending({
        mode: "notice",
        text:
          "This is a shortened share link, which cannot be read without following it. " +
          "Open it once in Google Maps, then paste the full address-bar URL instead.",
      });
      return true;
    }
    if (parsed.kind === "osm") {
      void lookupOsm(parsed.ref);
      return true;
    }
    if (parsed.kind === "apple") {
      confirmFacts(
        {
          lat: parsed.lat,
          lng: parsed.lng,
          origin: "apple-link",
          appleUrl: parsed.url,
        },
        parsed.name,
      );
      return true;
    }
    // Google: the URL string itself must carry the coordinates.
    if (parsed.lat === undefined || parsed.lng === undefined) {
      setPending({
        mode: "notice",
        text:
          "This link does not carry a location. Open it in the map app, make sure a specific " +
          "place is selected, then copy the URL again.",
      });
      return true;
    }
    confirmFacts(
      {
        lat: parsed.lat,
        lng: parsed.lng,
        origin: "google-link",
        googleUrl: parsed.url,
      },
      parsed.name,
    );
    return true;
  };

  const pickCandidate = (candidate: GeocoderCandidate) => {
    setOpen(false);
    setActiveIndex(-1);
    // Geocoder results are OSM data: the pick records its osmRef
    // (spec/src/data-model.md §Normative rules).
    confirmFacts(
      {
        lat: candidate.lat,
        lng: candidate.lng,
        ...(candidate.address ? { address: candidate.address } : {}),
        origin: "search",
        ...(candidate.osmRef ? { osmRef: candidate.osmRef } : {}),
      },
      candidate.name,
    );
  };

  const reset = () => {
    setPending(undefined);
    setQuery("");
    setName("");
    setOpen(false);
    setActiveIndex(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || results.length === 0) {
      if (e.key === "Escape") setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? results.length - 1 : i - 1));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      const candidate = results[activeIndex];
      if (candidate) pickCandidate(candidate);
    } else if (e.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div className="relative w-full" data-testid="add-place-field">
      <input
        type="search"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-label="Add a place"
        placeholder="Paste a map link, or search for a place…"
        value={query}
        onChange={(e) => {
          const next = e.target.value;
          // A URL is never a geocoder query: hand it to the link flow instead.
          if (takeLink(next)) {
            setQuery("");
            setOpen(false);
            setActiveIndex(-1);
            return;
          }
          setQuery(next);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="w-full rounded-crisp border border-hairline bg-paper px-3 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
      />

      {open && debouncedQuery.length >= 2 && pending === undefined ? (
        searchQuery.isPending || searchQuery.isError || results.length === 0 ? (
          <output
            className="absolute top-full right-0 left-0 z-30 mt-1 block rounded-crisp border border-hairline bg-panel px-3 py-2 text-sm"
            data-testid="search-status"
          >
            {searchQuery.isPending ? (
              <span className="text-ink/60">Searching…</span>
            ) : searchQuery.isError ? (
              <span className="text-ink">Search is unavailable right now.</span>
            ) : (
              <span className="text-ink/60">No places found.</span>
            )}
          </output>
        ) : (
          <ul
            id={listboxId}
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ul[role=listbox] with option children is the standard ARIA combobox pattern
            role="listbox"
            aria-label="Search results"
            className="absolute top-full right-0 left-0 z-30 mt-1 overflow-hidden rounded-crisp border border-hairline bg-panel"
          >
            {results.map((candidate, index) => (
              <li key={`${index.toString()}-${candidate.lat}-${candidate.lng}`} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onClick={() => pickCandidate(candidate)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`block w-full px-3 py-2 text-left text-sm ${
                    index === activeIndex ? "bg-ink/5" : ""
                  }`}
                >
                  <span className="font-medium text-ink">{candidate.name}</span>
                  {candidate.address ? (
                    <span className="block text-xs text-ink/60">{candidate.address}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {/* Every pending state floats as one panel below the field: the header
          row must never grow. Solid raised surfaces (bg-panel) so the panel
          reads over whatever the notebook is showing. */}
      {pending?.mode === "notice" ? (
        <output
          className="absolute top-full right-0 left-0 z-30 mt-1 block rounded-crisp border border-hairline bg-panel p-2 text-xs text-ink"
          data-testid="link-notice"
        >
          {pending.text}
          <button
            type="button"
            onClick={reset}
            className="ml-2 font-medium underline"
            data-testid="link-notice-dismiss"
          >
            OK
          </button>
        </output>
      ) : null}

      {pending?.mode === "lookup" ? (
        <output
          className="absolute top-full right-0 left-0 z-30 mt-1 block rounded-crisp border border-hairline bg-panel p-2 text-xs text-ink/60"
          data-testid="osm-lookup-pending"
        >
          Looking this up on OpenStreetMap…
        </output>
      ) : null}

      {pending?.mode === "lookup-error" ? (
        <output
          className="absolute top-full right-0 left-0 z-30 mt-1 block rounded-crisp border border-hairline bg-panel p-2 text-xs text-ink"
          data-testid="osm-lookup-error"
        >
          {pending.message}
          <span className="ml-2 inline-flex gap-2">
            <button
              type="button"
              onClick={() => void lookupOsm(pending.ref)}
              className="font-medium underline"
              data-testid="osm-lookup-retry"
            >
              Retry
            </button>
            <button type="button" onClick={reset} className="underline">
              Cancel
            </button>
          </span>
        </output>
      ) : null}

      {pending?.mode === "confirm" ? (
        <div
          className="absolute top-full right-0 left-0 z-30 mt-1 rounded-crisp border border-hairline bg-panel p-3"
          data-testid="add-place-confirm"
        >
          <div className="flex items-start justify-between gap-2">
            <label className="block min-w-0 flex-1 text-xs font-medium text-ink">
              Name
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={pending.suggestedName ? "Confirm or override" : "Name this place"}
                className="mt-1 w-full rounded-crisp border border-hairline bg-paper px-2 py-1.5 text-sm text-ink"
                data-testid="confirm-name"
              />
            </label>
            <button
              type="button"
              onClick={reset}
              aria-label="Cancel"
              className="rounded-crisp p-1 text-ink/60 hover:bg-ink/10"
            >
              ✕
            </button>
          </div>
          <p className="mt-1 font-mono text-[11px] text-ink/60">
            at {pending.facts.lat.toFixed(5)}, {pending.facts.lng.toFixed(5)}
          </p>
          {name.trim() === "" ? (
            <p className="mt-1 text-xs text-ink/60">Give the place a name to add it.</p>
          ) : (
            <AddToList
              source={{ kind: "new", facts: { ...pending.facts, name: name.trim() } }}
              lists={lists}
              idPrefix="field"
              onAdded={(place) => {
                const ref = pending.facts.osmRef;
                if (pending.facts.origin === "search" && ref && place.imageUrl === undefined) {
                  enrichSearchPick(place, ref);
                }
                reset();
                focusPlace(place.id);
              }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
