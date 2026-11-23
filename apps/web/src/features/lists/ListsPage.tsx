/**
 * Home — the library (spec/src/map-view.md §The library): every saved place,
 * found by filtering. The page has three parts, top to bottom:
 *
 *  - the filter: the top bar's search text plus facet chips (your tags, tags
 *    from reviews, rating, been / want to go, lists);
 *  - the groups, while no filter is active: lists (hand-curated, ordered,
 *    publishable) and saved views (a named filter that keeps itself up to
 *    date);
 *  - the places the filter matches.
 *
 * The canvas shows exactly the same places: the filter narrows the map as it
 * narrows this list, and each pin wears the marker of the group it is in.
 */
import {
  formatStars,
  isEmptyFilter,
  MIN_STAR_CHOICES,
  markerKey,
  matchesFilter,
  type PlaceFacets,
  type PlaceFilter,
  placeKindLine,
  tagCounts,
} from "@placemarks/domain";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useListPreviews, useViews } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { toggled, useLibraryStore } from "../../state/library";
import { useCanvasProjection, useSelectionStore } from "../../state/projection";
import { useLibraryFacets } from "../library/facets";
import { RatingStars } from "../library/Stars";
import { DerivedTag, OwnTag } from "../library/TagChip";
import { MarkerGlyph } from "./MarkerGlyph";
import { NewListForm } from "./NewListForm";

type Facet = "tags" | "reviews" | "rating" | "status" | "lists";

/** How many result rows render before "Show more" — keeps a big library quick. */
const PAGE = 60;

export function ListsPage() {
  const repo = useRepo();
  const [creating, setCreating] = useState(false);
  const [openFacet, setOpenFacet] = useState<Facet>();
  const [savingView, setSavingView] = useState(false);
  const [viewName, setViewName] = useState("");
  const [shown, setShown] = useState(PAGE);
  const rows = useListPreviews();
  const views = useViews();
  const facets = useLibraryFacets();
  const filter = useLibraryStore((s) => s.filter);
  const patchFilter = useLibraryStore((s) => s.patchFilter);
  const setFilter = useLibraryStore((s) => s.setFilter);
  const clearFilter = useLibraryStore((s) => s.clearFilter);
  const focusPlace = useSelectionStore((s) => s.focusPlace);
  const selectedPlaceId = useSelectionStore((s) => s.selectedPlaceId);
  // Home projects the library: every layer's places, narrowed by the filter
  // (spec/src/map-view.md §The grammar).
  useCanvasProjection({ kind: "lists-overlay" });

  const active = !isEmptyFilter(filter);
  const all = facets ?? [];
  const matches = useMemo(
    () => (active ? all.filter((f) => matchesFilter(f, filter)) : all),
    [all, filter, active],
  );
  const ownTagCounts = useMemo(() => tagCounts(all.map((f) => f.place.tags ?? [])), [all]);
  const derivedTagCounts = useMemo(() => tagCounts(all.map((f) => f.derivedTags)), [all]);
  const viewCounts = useMemo(
    () =>
      new Map(
        (views ?? []).map((v) => [v.id, all.filter((f) => matchesFilter(f, v.filter)).length]),
      ),
    [views, all],
  );
  const unlistedCount = useMemo(() => all.filter((f) => f.listIds.length === 0).length, [all]);
  const listsById = new Map((rows ?? []).map(({ list }) => [list.id, list]));

  // Beyond 64 live lists pairs repeat with a numeral badge as the
  // deterministic variant — derived from list order, never stored
  // (spec/src/data-model.md §Markers).
  const wearCounts = new Map<string, number>();
  const badges = new Map<string, number>();
  for (const { list } of rows ?? []) {
    const worn = (wearCounts.get(markerKey(list.marker)) ?? 0) + 1;
    wearCounts.set(markerKey(list.marker), worn);
    if (worn > 1) badges.set(list.id, worn);
  }

  const facetCount = (facet: Facet): number =>
    facet === "tags"
      ? (filter.tags?.length ?? 0)
      : facet === "reviews"
        ? (filter.derivedTags?.length ?? 0)
        : facet === "rating"
          ? Number(filter.minStars !== undefined)
          : facet === "status"
            ? Number(filter.status !== undefined)
            : (filter.listIds?.length ?? 0) + Number(filter.unlisted === true);

  const facetButton = (facet: Facet, label: string, available: boolean) =>
    available ? (
      <button
        type="button"
        aria-expanded={openFacet === facet}
        onClick={() => setOpenFacet(openFacet === facet ? undefined : facet)}
        data-testid={`facet-${facet}`}
        className={`rounded-pill border px-2.5 py-1 text-xs font-medium ${
          facetCount(facet) > 0
            ? "border-ink bg-ink text-paper"
            : openFacet === facet
              ? "border-ink text-ink"
              : "border-hairline text-ink hover:bg-hover"
        }`}
      >
        {label}
        {facetCount(facet) > 0 ? ` · ${facetCount(facet).toString()}` : ""}
      </button>
    ) : null;

  const saveView = () => {
    const name = viewName.trim();
    if (name === "") return;
    void repo.createView(name, filter).then(() => {
      setSavingView(false);
      setViewName("");
    });
  };

  const applyFilter = (next: PlaceFilter) => {
    setFilter(next);
    setShown(PAGE);
  };

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="lists-page">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-[2.25rem] leading-none font-semibold tracking-tight text-ink">
          Places
          {facets !== undefined ? (
            <span
              className="ml-2 font-mono text-sm font-normal text-ink/60"
              data-testid="place-total"
            >
              {all.length}
            </span>
          ) : null}
        </h1>
        <div className="flex items-center gap-2">
          {creating ? null : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-pill bg-ink px-3.5 py-1.5 text-sm font-medium text-paper shadow-lift"
              data-testid="new-list"
            >
              + New list
            </button>
          )}
          <Link
            to="/settings"
            hash="import"
            className="rounded-pill border border-hairline px-3 py-1.5 text-sm font-medium text-ink"
            data-testid="import-entry"
          >
            ⤓ Import
          </Link>
        </div>
      </div>

      {creating ? (
        <div className="mt-3">
          <NewListForm
            submitLabel="Create list"
            submitTestId="create-list"
            onCreate={(name) => {
              setCreating(false);
              void repo.createList(name);
            }}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : null}

      {/* The filter: facet chips. Free text is typed in the top bar. */}
      {all.length > 0 ? (
        <section className="mt-4" aria-label="Filter places" data-testid="library-filter">
          <div className="flex flex-wrap items-center gap-1.5">
            {facetButton("tags", "Your tags", ownTagCounts.length > 0)}
            {facetButton("reviews", "From reviews", derivedTagCounts.length > 0)}
            {facetButton("rating", "Rating", true)}
            {facetButton("status", "Been / want", true)}
            {facetButton("lists", "Lists", (rows ?? []).length > 0)}
          </div>

          {openFacet === "tags" ? (
            <div className="mt-2 flex flex-wrap gap-1.5" data-testid="facet-panel-tags">
              {ownTagCounts.map(({ tag, count }) => (
                <OwnTag
                  key={tag}
                  tag={tag}
                  count={count}
                  pressed={filter.tags?.includes(tag) ?? false}
                  onClick={() => patchFilter({ tags: toggled(filter.tags, tag) })}
                  testId="filter-own-tag"
                />
              ))}
            </div>
          ) : null}
          {openFacet === "reviews" ? (
            <div className="mt-2" data-testid="facet-panel-reviews">
              <p className="text-[11px] text-ink/60">
                Tags the review classifier found in other people's reviews — not your own.
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {derivedTagCounts.map(({ tag, count }) => (
                  <DerivedTag
                    key={tag}
                    tag={tag}
                    count={count}
                    pressed={filter.derivedTags?.includes(tag) ?? false}
                    onClick={() => patchFilter({ derivedTags: toggled(filter.derivedTags, tag) })}
                    testId="filter-derived-tag"
                  />
                ))}
              </div>
            </div>
          ) : null}
          {openFacet === "rating" ? (
            <div className="mt-2 flex flex-wrap gap-1.5" data-testid="facet-panel-rating">
              {MIN_STAR_CHOICES.map((min) => (
                <button
                  key={min}
                  type="button"
                  aria-pressed={filter.minStars === min}
                  aria-label={min < 5 ? `${formatStars(min)} stars or more` : "5 stars"}
                  data-testid={`min-stars-${formatStars(min)}`}
                  onClick={() =>
                    applyFilter({
                      ...filter,
                      minStars: filter.minStars === min ? undefined : min,
                    } as PlaceFilter)
                  }
                  className={`rounded-pill border px-2.5 py-1 font-mono text-xs ${
                    filter.minStars === min
                      ? "border-ink bg-ink text-paper"
                      : "border-hairline text-ink hover:bg-hover"
                  }`}
                >
                  ★ {formatStars(min)}
                  {min < 5 ? "+" : ""}
                </button>
              ))}
            </div>
          ) : null}
          {openFacet === "status" ? (
            <div className="mt-2 flex flex-wrap gap-1.5" data-testid="facet-panel-status">
              {(
                [
                  ["been", "Been"],
                  ["want", "Want to go"],
                ] as const
              ).map(([status, label]) => (
                <button
                  key={status}
                  type="button"
                  aria-pressed={filter.status === status}
                  onClick={() =>
                    applyFilter({
                      ...filter,
                      status: filter.status === status ? undefined : status,
                    } as PlaceFilter)
                  }
                  className={`rounded-pill border px-2.5 py-1 text-xs ${
                    filter.status === status
                      ? "border-ink bg-ink text-paper"
                      : "border-hairline text-ink hover:bg-hover"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
          {openFacet === "lists" ? (
            <div className="mt-2 flex flex-wrap gap-1.5" data-testid="facet-panel-lists">
              {(rows ?? []).map(({ list }) => {
                const on = filter.listIds?.includes(list.id) ?? false;
                return (
                  <button
                    key={list.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      patchFilter({ listIds: toggled(filter.listIds, list.id), unlisted: false })
                    }
                    className={`inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-xs ${
                      on ? "border-ink bg-wash text-ink" : "border-hairline text-ink hover:bg-hover"
                    }`}
                  >
                    <MarkerGlyph marker={list.marker} size={12} />
                    {list.name}
                  </button>
                );
              })}
              {unlistedCount > 0 ? (
                <button
                  type="button"
                  aria-pressed={filter.unlisted === true}
                  onClick={() => patchFilter({ unlisted: filter.unlisted !== true, listIds: [] })}
                  className={`rounded-pill border px-2 py-0.5 text-xs ${
                    filter.unlisted === true
                      ? "border-ink bg-wash text-ink"
                      : "border-hairline text-ink hover:bg-hover"
                  }`}
                  data-testid="filter-unlisted"
                >
                  On no list · {unlistedCount}
                </button>
              ) : null}
            </div>
          ) : null}

          {active ? (
            <div
              className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink"
              data-testid="filter-summary"
            >
              {(filter.text ?? "").trim() !== "" ? (
                <span className="inline-flex items-center gap-1 rounded-pill border border-ink px-2 py-0.5">
                  “{(filter.text ?? "").trim()}”
                  <button
                    type="button"
                    aria-label="Clear search text"
                    onClick={() => patchFilter({ text: "" })}
                    className="opacity-70 hover:opacity-100"
                  >
                    ✕
                  </button>
                </span>
              ) : null}
              <span className="font-mono text-ink/70" data-testid="match-count">
                {matches.length} of {all.length}
              </span>
              {savingView ? (
                <span className="inline-flex items-center gap-1">
                  <input
                    type="text"
                    value={viewName}
                    onChange={(e) => setViewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveView();
                      if (e.key === "Escape") setSavingView(false);
                    }}
                    placeholder="Name this view"
                    aria-label="View name"
                    className="w-36 rounded-pill border border-hairline bg-paper px-2 py-0.5 text-xs text-ink"
                    data-testid="view-name-input"
                    // biome-ignore lint/a11y/noAutofocus: the field appears in direct response to pressing "Save as view"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={saveView}
                    disabled={viewName.trim() === ""}
                    className="rounded-pill bg-ink px-2 py-0.5 font-medium text-paper disabled:opacity-40"
                    data-testid="confirm-save-view"
                  >
                    Save
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setSavingView(true)}
                  className="rounded-pill border border-hairline px-2 py-0.5 font-medium hover:bg-hover"
                  data-testid="save-view"
                >
                  Save as view
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  clearFilter();
                  setOpenFacet(undefined);
                }}
                className="underline"
                data-testid="clear-filter"
              >
                Clear
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* The groups — lists and saved views — while nothing is being searched. */}
      {!active ? (
        <section className="mt-5" aria-label="Groups">
          {(rows ?? []).length > 0 || (views ?? []).length > 0 ? (
            <h2 className="eyebrow">Lists &amp; views</h2>
          ) : null}
          <ul className="mt-1 divide-y divide-hairline">
            {(rows ?? []).map(({ list, placeCount }) => (
              <li key={list.id} data-testid="list-row">
                <div className="flex items-center gap-3 px-1 py-3 hover:bg-hover">
                  <MarkerGlyph
                    marker={list.marker}
                    size={20}
                    {...(badges.has(list.id) ? { badge: badges.get(list.id) as number } : {})}
                  />
                  <Link
                    to="/list/$listId"
                    params={{ listId: list.id }}
                    className="min-w-0 flex-1 truncate"
                  >
                    <span className="font-medium text-ink">{list.name}</span>
                    <span
                      className="ml-2 font-mono text-xs text-ink/60"
                      data-testid="list-place-count"
                    >
                      {placeCount} {placeCount === 1 ? "place" : "places"}
                    </span>
                  </Link>
                </div>
              </li>
            ))}
            {(views ?? []).map((view) => (
              <li key={view.id} data-testid="view-row">
                <div className="flex items-center gap-3 px-1 py-3 hover:bg-hover">
                  <MarkerGlyph marker={view.marker} size={20} />
                  <button
                    type="button"
                    onClick={() => applyFilter(view.filter)}
                    className="min-w-0 flex-1 truncate text-left"
                    data-testid="open-view"
                  >
                    <span className="font-medium text-ink">{view.name}</span>
                    <span className="ml-2 font-mono text-xs text-ink/60">
                      view · {viewCounts.get(view.id) ?? 0}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete view ${view.name}`}
                    onClick={() => void repo.deleteView(view.id)}
                    className="rounded-pill px-1.5 py-0.5 text-xs text-ink/60 hover:text-ink"
                    data-testid="delete-view"
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {rows !== undefined && rows.length === 0 && all.length === 0 && !creating ? (
            <p className="py-6 text-sm text-ink/60">
              Nothing saved yet. Search for a place or paste a map link in the top bar, or import
              your saved places.
            </p>
          ) : null}
        </section>
      ) : null}

      {/* The places the filter matches — the same set the map is showing. */}
      {all.length > 0 ? (
        <section className="mt-5" aria-label="Places">
          <h2 className="eyebrow">{active ? "Matches" : "All places"}</h2>
          <ul className="mt-1 divide-y divide-hairline border-y border-hairline">
            {matches.slice(0, shown).map((f) => (
              <PlaceRow
                key={f.place.id}
                facets={f}
                selected={selectedPlaceId === f.place.id}
                onSelect={() => focusPlace(f.place.id)}
                markers={f.listIds
                  .map((id) => listsById.get(id))
                  .filter((l): l is NonNullable<typeof l> => l !== undefined)}
              />
            ))}
            {matches.length === 0 ? (
              <li className="px-2 py-4 text-sm text-ink/60" data-testid="no-matches">
                No saved place matches. The top bar's results below “Add a new place” search the
                wider map.
              </li>
            ) : null}
          </ul>
          {matches.length > shown ? (
            <button
              type="button"
              onClick={() => setShown(shown + PAGE)}
              className="mt-3 rounded-pill border border-hairline px-3 py-1.5 text-sm font-medium text-ink"
            >
              Show more ({matches.length - shown} left)
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function PlaceRow({
  facets,
  selected,
  onSelect,
  markers,
}: {
  facets: PlaceFacets;
  selected: boolean;
  onSelect: () => void;
  markers: { id: string; marker: Parameters<typeof MarkerGlyph>[0]["marker"]; name: string }[];
}) {
  const { place } = facets;
  const kind = placeKindLine(place);
  return (
    <li data-testid="library-place">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={`block w-full px-2 py-2.5 text-left hover:bg-hover ${selected ? "bg-hover" : ""}`}
      >
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate font-medium text-ink">{place.name}</span>
          <RatingStars stars={place.stars} />
          {place.status ? (
            <span className="shrink-0 font-mono text-[10px] text-ink/60 uppercase">
              {place.status === "been" ? "been" : "want"}
            </span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            {markers.map((list) => (
              <span key={list.id} title={list.name}>
                <MarkerGlyph marker={list.marker} size={12} />
              </span>
            ))}
          </span>
        </span>
        {kind || place.address ? (
          <span className="mt-0.5 block truncate text-xs text-ink/70">
            {[kind, place.address].filter(Boolean).join(" — ")}
          </span>
        ) : null}
        {/* Rows carry the owner's own tags only; review tags stay on the
            card and in the filter, so a list of places reads as yours. */}
        {(place.tags?.length ?? 0) > 0 ? (
          <span className="mt-1 flex flex-wrap gap-1">
            {(place.tags ?? []).map((tag) => (
              <OwnTag key={tag} tag={tag} />
            ))}
          </span>
        ) : null}
        {place.note ? (
          <span className="mt-1 block truncate text-xs text-ink/80 italic">“{place.note}”</span>
        ) : null}
      </button>
    </li>
  );
}
