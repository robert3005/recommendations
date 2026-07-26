/**
 * Type-ahead search (Photon). Debounced, cancellable, keyboard-accessible combobox.
 * Every selectable result carries a typed OSM reference (spec/src/data-sources.md).
 */
import type { SearchResult } from "@placemarks/domain";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { searchProvider } from "../../providers";

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface SearchBarProps {
  onSelect: (result: SearchResult) => void;
  bias?: { lat: number; lng: number };
}

export function SearchBar({ onSelect, bias }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const debouncedQuery = useDebounced(query.trim(), 250);
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const searchQuery = useQuery({
    queryKey: ["search", debouncedQuery, bias?.lat, bias?.lng],
    queryFn: ({ signal }) =>
      searchProvider.search(debouncedQuery, { signal, ...(bias ? { bias } : {}) }),
    enabled: debouncedQuery.length >= 2,
    placeholderData: (prev) => prev,
  });

  const results = debouncedQuery.length >= 2 ? (searchQuery.data ?? []) : [];

  const select = (result: SearchResult) => {
    setOpen(false);
    setQuery(result.name);
    setActiveIndex(-1);
    onSelect(result);
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
      const result = results[activeIndex];
      if (result) select(result);
    } else if (e.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div className="relative w-full max-w-md" data-testid="search-bar">
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-label="Search places"
        placeholder="Search places, addresses…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="w-full rounded-full border border-rule bg-paper px-4 py-2 text-sm shadow-md focus:border-ink-3 focus:outline-none"
      />
      {open && debouncedQuery.length >= 2 ? (
        // A listbox may only contain options — status text renders as its own
        // live region instead (continuous axe check, spec/src/roadmap.md).
        searchQuery.isPending || searchQuery.isError || results.length === 0 ? (
          <output
            className="absolute top-full right-0 left-0 z-30 mt-1 block rounded-xl border border-rule bg-paper px-4 py-2 text-sm shadow-lg"
            data-testid="search-status"
          >
            {searchQuery.isPending ? (
              <span className="text-ink-3">Searching…</span>
            ) : searchQuery.isError ? (
              <span className="text-coral-ink">Search is unavailable right now.</span>
            ) : (
              <span className="text-ink-3">No places found.</span>
            )}
          </output>
        ) : (
          <ul
            id={listboxId}
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ul[role=listbox] with option children is the standard ARIA combobox pattern
            role="listbox"
            aria-label="Search results"
            className="absolute top-full right-0 left-0 z-30 mt-1 overflow-hidden rounded-xl border border-rule bg-paper shadow-lg"
          >
            {results.map((result, index) => (
              <li key={`${result.ref.type}/${result.ref.id}`} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onClick={() => select(result)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`block w-full px-4 py-2 text-left text-sm ${
                    index === activeIndex ? "bg-land" : ""
                  }`}
                >
                  <span className="font-medium text-ink">{result.name}</span>
                  {result.category ? (
                    <span className="ml-2 text-xs capitalize text-ink-3">{result.category}</span>
                  ) : null}
                  {result.address ? (
                    <span className="block text-xs text-ink-3">{result.address}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
