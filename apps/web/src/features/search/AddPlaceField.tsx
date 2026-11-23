/**
 * The search field (spec/src/map-view.md §The search field): one field for
 * finding a place you saved and for adding a new one. Typing searches the
 * library first — name, your tags and notes, facts, and review text — and
 * the wider map second, biased toward what the canvas is showing. Paste a
 * Google Maps / Apple Maps / OSM URL instead and it is parsed locally; a
 * `maps.app.goo.gl` short link is first expanded by the share service, which
 * follows its redirect and returns only the full URL. A new place is
 * saved to the library with one press; putting it on a list is optional
 * (spec/src/data-model.md §The library).
 *
 * The field lives in the notebook's top bar (2026-07-26 — search-first
 * chrome): a compact single-line input whose results, notices, and the
 * confirm card all open as a floating panel below the header — nothing here
 * may grow the header row.
 *
 * Two pastes make a network call: an OSM element URL (the geocoder's exact
 * `lookup` fetches that element's facts) and a short link (the expansion
 * above). Offline both fail politely — nothing queues; the user retries
 * online (spec/src/interop.md).
 */
import type { GeocoderCandidate, OsmRef, PlaceFacets } from "@placemarks/domain";
import { matchesFilter, parsePastedLink, placeKindLine } from "@placemarks/domain";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useLists } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import type { NewPlaceFacts } from "../../data/repo";
import { geocoder, type PlaceSuggestion } from "../../providers";
import { useLibraryStore } from "../../state/library";
import { useSelectionStore } from "../../state/projection";
import { useUiStore } from "../../state/ui";
import { useLibraryFacets } from "../library/facets";
import { RatingStars } from "../library/Stars";
import { OwnTag } from "../library/TagChip";
import { AddToList } from "../place/AddToList";
import { enrichPlace } from "../place/enrichment";
import { expandShortLink } from "./resolveLink";

type Pending =
  | { mode: "notice"; text: string }
  | { mode: "lookup"; ref: OsmRef }
  | { mode: "lookup-error"; ref: OsmRef; message: string }
  | { mode: "expand"; url: string }
  | { mode: "expand-error"; url: string }
  | { mode: "resolve"; suggestion: PlaceSuggestion }
  | { mode: "resolve-error"; suggestion: PlaceSuggestion }
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
  /** Bias search toward a point; defaults to where the map is looking. */
  bias?: { lat: number; lng: number };
  /** "Show all matches": the shell navigates home, where the filter lives. */
  onShowAll?: () => void;
}

/** Library matches offered in the dropdown before "show all". */
const LIBRARY_LIMIT = 5;

/** Floats below the whole top bar, not just the field, so it is wide enough to read on a phone. */
const PANEL =
  "absolute top-full right-2 left-2 z-30 mt-1 rounded-crisp border border-hairline bg-panel shadow-lift";

type Option =
  | { kind: "library"; facets: PlaceFacets }
  | { kind: "all"; count: number }
  | { kind: "geo"; suggestion: PlaceSuggestion };

export function AddPlaceField({ bias: biasProp, onShowAll }: AddPlaceFieldProps) {
  const repo = useRepo();
  const lists = useLists();
  // Select AND fly in one call (spec/src/map-view.md §Selection is bidirectional).
  const focusPlace = useSelectionStore((s) => s.focusPlace);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pending, setPending] = useState<Pending>();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const debouncedQuery = useDebounced(query.trim(), 250);
  const listboxId = useId();
  const fieldRef = useRef<HTMLDivElement>(null);
  /** Counts paste/pick fetches so a late answer never lands on a newer state. */
  const asyncRun = useRef(0);

  // The results are a transient dropdown: pressing anywhere outside the field
  // (the map, a list, the gear, the home link) or moving focus elsewhere puts
  // them away. The typed text stays, so focusing the field brings them back.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && fieldRef.current?.contains(e.target)) return;
      setOpen(false);
      setActiveIndex(-1);
    };
    // Only a focus move to a known element outside closes here: a press that
    // leaves focus nowhere (Safari does not focus buttons) is the pointer
    // handler's to judge, so a click on an option still lands.
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget;
      if (next instanceof Node && !fieldRef.current?.contains(next)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    };
    const field = fieldRef.current;
    document.addEventListener("pointerdown", onPointerDown, true);
    field?.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      field?.removeEventListener("focusout", onFocusOut);
    };
  }, [open]);
  // The geocoder leans toward what the canvas shows; coarsened so panning a
  // little does not re-run the search.
  const mapCenter = useUiStore((s) => s.mapCenter);
  const bias =
    biasProp ??
    (mapCenter
      ? { lat: Math.round(mapCenter.lat * 10) / 10, lng: Math.round(mapCenter.lng * 10) / 10 }
      : undefined);
  const patchFilter = useLibraryStore((s) => s.patchFilter);
  const library = useLibraryFacets();

  const searchQuery = useQuery({
    queryKey: ["geocode", debouncedQuery, bias?.lat, bias?.lng],
    queryFn: () => geocoder.suggest(debouncedQuery, bias),
    enabled: debouncedQuery.length >= 2,
    placeholderData: (prev) => prev,
  });
  const results: PlaceSuggestion[] = debouncedQuery.length >= 2 ? (searchQuery.data ?? []) : [];

  // The library answers instantly and comes first: what you saved outranks
  // anything the wider map knows.
  const typed = query.trim();
  const libraryMatches =
    typed.length >= 2 ? (library ?? []).filter((f) => matchesFilter(f, { text: typed })) : [];
  const savedOsm = new Set(
    (library ?? []).flatMap((f) =>
      f.place.osmRef ? [`${f.place.osmRef.type}/${f.place.osmRef.id}`] : [],
    ),
  );
  // A geocoder hit that is already saved is not offered as "new"; identical
  // name + location repeats collapse to one row.
  const seenGeo = new Set<string>();
  const freshResults = results.filter((c) => {
    if (c.osmRef && savedOsm.has(`${c.osmRef.type}/${c.osmRef.id}`)) return false;
    const key = `${c.name}|${c.where ?? ""}`;
    if (seenGeo.has(key)) return false;
    seenGeo.add(key);
    return true;
  });
  const options: Option[] = [
    ...libraryMatches
      .slice(0, LIBRARY_LIMIT)
      .map((facets) => ({ kind: "library", facets }) as const),
    ...(libraryMatches.length > 0 && onShowAll
      ? [{ kind: "all", count: libraryMatches.length } as const]
      : []),
    ...freshResults.map((suggestion) => ({ kind: "geo", suggestion }) as const),
  ];

  const showAll = () => {
    patchFilter({ text: typed });
    setOpen(false);
    setActiveIndex(-1);
    setQuery("");
    onShowAll?.();
  };

  const pickOption = (option: Option) => {
    if (option.kind === "library") {
      setOpen(false);
      setActiveIndex(-1);
      setQuery("");
      focusPlace(option.facets.place.id);
    } else if (option.kind === "all") {
      showAll();
    } else {
      void pickSuggestion(option.suggestion);
    }
  };

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
   * A short link reveals nothing until its redirect is followed: the share
   * service does that and the full URL it returns goes through the same local
   * parsing as a pasted one. A stale answer (the user moved on) is dropped.
   */
  const expandLink = async (url: string) => {
    const run = ++asyncRun.current;
    setPending({ mode: "expand", url });
    let expanded: string | undefined;
    try {
      expanded = await expandShortLink(url);
    } catch {
      expanded = undefined;
    }
    if (run !== asyncRun.current) return;
    const parsed = expanded ? parsePastedLink(expanded) : undefined;
    if (!parsed || parsed.kind !== "google") {
      setPending({ mode: "expand-error", url });
      return;
    }
    takeLink(expanded as string);
  };

  /** Returns true when the input was taken as a map link. */
  const takeLink = (raw: string): boolean => {
    const parsed = parsePastedLink(raw);
    if (!parsed) return false;
    if (parsed.kind === "short-link") {
      void expandLink(parsed.url);
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

  /**
   * A suggestion is only a name and a rough "where": the pick fetches the full
   * record — its position and address — before the confirm card can open. A
   * stale answer (the user moved on) is dropped.
   */
  const pickSuggestion = async (suggestion: PlaceSuggestion) => {
    const run = ++asyncRun.current;
    setOpen(false);
    setActiveIndex(-1);
    setPending({ mode: "resolve", suggestion });
    let candidate: GeocoderCandidate | undefined;
    try {
      candidate = await geocoder.resolve(suggestion.id);
    } catch {
      candidate = undefined;
    }
    if (run !== asyncRun.current) return;
    if (!candidate) {
      setPending({ mode: "resolve-error", suggestion });
      return;
    }
    // A result sourced from OSM records its osmRef; any other source carries
    // none (spec/src/data-model.md §Normative rules).
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
    asyncRun.current++;
    setPending(undefined);
    setQuery("");
    setName("");
    setOpen(false);
    setActiveIndex(-1);
  };

  /** Save to the library on no list — the one-press path. */
  const saveWithoutList = async (facts: NewPlaceFacts) => {
    setSaving(true);
    try {
      const result = await repo.savePlace(facts);
      // Already in the library (exactly, or by name and position): open that
      // place rather than minting a second copy.
      const place = result.status === "name-proximity-conflict" ? result.existing : result.place;
      if (result.status === "saved") void enrichPlace(repo, geocoder, place);
      reset();
      focusPlace(place.id);
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || options.length === 0) {
      if (e.key === "Escape") setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? options.length - 1 : i - 1));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      const option = options[activeIndex];
      if (option) pickOption(option);
    } else if (e.key === "Enter" && libraryMatches.length > 0 && onShowAll) {
      // Enter with nothing highlighted: show every match on the map.
      e.preventDefault();
      showAll();
    } else if (e.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div ref={fieldRef} className="w-full" data-testid="add-place-field">
      <input
        type="search"
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-label="Add a place"
        placeholder="Search or paste a link"
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
        className="w-full rounded-pill border border-hairline bg-paper px-3 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
      />

      {open && typed.length >= 2 && pending === undefined ? (
        <div className={`${PANEL} max-h-[70vh] overflow-y-auto`} data-testid="search-panel">
          {options.length > 0 ? (
            <ul
              id={listboxId}
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ul[role=listbox] with option children is the standard ARIA combobox pattern
              role="listbox"
              aria-label="Search results"
            >
              {options.map((option, index) => {
                const first = index === 0 || options[index - 1]?.kind !== option.kind;
                const heading =
                  option.kind === "library" && first
                    ? "Your places"
                    : option.kind === "geo" && first
                      ? "Add a new place"
                      : undefined;
                const active = index === activeIndex ? "bg-hover" : "";
                return (
                  <li
                    key={
                      option.kind === "library"
                        ? `lib-${option.facets.place.id}`
                        : option.kind === "all"
                          ? "all"
                          : `geo-${option.suggestion.id}`
                    }
                    role="presentation"
                  >
                    {heading ? (
                      <p
                        className="label-mono border-t border-hairline px-3 pt-2 pb-0.5 text-ink/60 first:border-t-0"
                        data-testid={`search-section-${option.kind}`}
                      >
                        {heading}
                      </p>
                    ) : null}
                    {option.kind === "library" ? (
                      <button
                        type="button"
                        role="option"
                        aria-selected={index === activeIndex}
                        onClick={() => pickOption(option)}
                        onMouseEnter={() => setActiveIndex(index)}
                        className={`block w-full px-3 py-2 text-left text-sm ${active}`}
                        data-testid="search-library-option"
                      >
                        <span className="flex items-baseline gap-2">
                          <span className="font-medium text-ink">{option.facets.place.name}</span>
                          <RatingStars stars={option.facets.place.stars} />
                        </span>
                        <span className="block truncate text-xs text-ink/60">
                          {[placeKindLine(option.facets.place), option.facets.place.address]
                            .filter(Boolean)
                            .join(" — ")}
                        </span>
                        {(option.facets.place.tags?.length ?? 0) > 0 ? (
                          <span className="mt-1 flex flex-wrap gap-1">
                            {(option.facets.place.tags ?? []).slice(0, 4).map((tag) => (
                              <OwnTag key={tag} tag={tag} />
                            ))}
                          </span>
                        ) : null}
                      </button>
                    ) : option.kind === "all" ? (
                      <button
                        type="button"
                        role="option"
                        aria-selected={index === activeIndex}
                        onClick={() => pickOption(option)}
                        onMouseEnter={() => setActiveIndex(index)}
                        className={`block w-full px-3 py-2 text-left text-sm font-medium text-ink underline ${active}`}
                        data-testid="search-show-all"
                      >
                        Show all {option.count} on the map
                      </button>
                    ) : (
                      <button
                        type="button"
                        role="option"
                        aria-selected={index === activeIndex}
                        onClick={() => pickOption(option)}
                        onMouseEnter={() => setActiveIndex(index)}
                        className={`block w-full px-3 py-2 text-left text-sm ${active}`}
                      >
                        <span className="font-medium text-ink">{option.suggestion.name}</span>
                        {option.suggestion.where ? (
                          <span className="block text-xs text-ink/60">
                            {option.suggestion.where}
                          </span>
                        ) : null}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {debouncedQuery.length >= 2 &&
          (searchQuery.isPending || searchQuery.isError || freshResults.length === 0) ? (
            <output
              className={`block px-3 py-2 text-sm ${options.length > 0 ? "border-t border-hairline" : ""}`}
              data-testid="search-status"
            >
              {searchQuery.isPending ? (
                <span className="text-ink/60">Searching…</span>
              ) : searchQuery.isError ? (
                <span className="text-ink">Search is unavailable right now.</span>
              ) : (
                <span className="text-ink/60">
                  {libraryMatches.length > 0 ? "No other places found." : "No places found."}
                </span>
              )}
            </output>
          ) : null}
        </div>
      ) : null}

      {/* Every pending state floats as one panel below the field: the header
          row must never grow. Solid raised surfaces (bg-panel) so the panel
          reads over whatever the notebook is showing. */}
      {pending?.mode === "notice" ? (
        <output className={`${PANEL} block p-2 text-xs text-ink`} data-testid="link-notice">
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
          className={`${PANEL} block p-2 text-xs text-ink/60`}
          data-testid="osm-lookup-pending"
        >
          Looking this up on OpenStreetMap…
        </output>
      ) : null}

      {pending?.mode === "lookup-error" ? (
        <output className={`${PANEL} block p-2 text-xs text-ink`} data-testid="osm-lookup-error">
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

      {pending?.mode === "expand" ? (
        <output
          className={`${PANEL} block p-2 text-xs text-ink/60`}
          data-testid="link-expand-pending"
        >
          Opening this share link…
        </output>
      ) : null}

      {pending?.mode === "expand-error" ? (
        <output className={`${PANEL} block p-2 text-xs text-ink`} data-testid="link-expand-error">
          Could not open this share link. Try again when you are online, or open it in Google Maps
          and paste the full address-bar URL instead.
          <span className="ml-2 inline-flex gap-2">
            <button
              type="button"
              onClick={() => void expandLink(pending.url)}
              className="font-medium underline"
              data-testid="link-expand-retry"
            >
              Retry
            </button>
            <button type="button" onClick={reset} className="underline">
              Cancel
            </button>
          </span>
        </output>
      ) : null}

      {pending?.mode === "resolve" ? (
        <output
          className={`${PANEL} block p-2 text-xs text-ink/60`}
          data-testid="place-resolve-pending"
        >
          Finding {pending.suggestion.name}…
        </output>
      ) : null}

      {pending?.mode === "resolve-error" ? (
        <output className={`${PANEL} block p-2 text-xs text-ink`} data-testid="place-resolve-error">
          Could not load {pending.suggestion.name}. Try again when you are online.
          <span className="ml-2 inline-flex gap-2">
            <button
              type="button"
              onClick={() => void pickSuggestion(pending.suggestion)}
              className="font-medium underline"
              data-testid="place-resolve-retry"
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
        <div className={`${PANEL} p-3`} data-testid="add-place-confirm">
          <div className="flex items-start justify-between gap-2">
            <label className="block min-w-0 flex-1 text-xs font-medium text-ink">
              Name
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={pending.suggestedName ? "Confirm or override" : "Name this place"}
                className="mt-1 w-full rounded-pill border border-hairline bg-paper px-2 py-1.5 text-sm text-ink"
                data-testid="confirm-name"
              />
            </label>
            <button
              type="button"
              onClick={reset}
              aria-label="Cancel"
              className="rounded-pill p-1 text-ink/60 hover:bg-hover"
            >
              ✕
            </button>
          </div>
          {pending.facts.address ? (
            <p className="mt-1 text-xs text-ink/80" data-testid="confirm-where">
              {pending.facts.address}
            </p>
          ) : null}
          <p className="mt-1 font-mono text-[11px] text-ink/60">
            at {pending.facts.lat.toFixed(5)}, {pending.facts.lng.toFixed(5)}
          </p>
          {name.trim() === "" ? (
            <p className="mt-1 text-xs text-ink/60">Give the place a name to add it.</p>
          ) : (
            <>
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveWithoutList({ ...pending.facts, name: name.trim() })}
                className="mt-2 rounded-pill bg-ink px-3.5 py-1.5 text-sm font-medium text-paper disabled:opacity-40"
                data-testid="save-place"
              >
                Save place
              </button>
              <p className="mt-2 text-xs text-ink/60">Or put it straight on a list:</p>
              <AddToList
                source={{ kind: "new", facts: { ...pending.facts, name: name.trim() } }}
                lists={lists}
                idPrefix="field"
                onAdded={(place) => {
                  // Post-add enrichment (spec/src/data-model.md §Normative
                  // rules): one shared best-effort pass fills missing facts
                  // from the element's tags and its Wikipedia article. It
                  // skips pins without an osmRef and never blocks the add.
                  void enrichPlace(repo, geocoder, place);
                  reset();
                  focusPlace(place.id);
                }}
              />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
