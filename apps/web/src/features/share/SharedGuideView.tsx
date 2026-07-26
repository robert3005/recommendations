/**
 * The public read-only viewer for shared lists and posts (spec/src/sharing.md
 * §Public viewer): paints immediately from copied evidence / manual facts,
 * live-resolves OSM anchors (evidence stays visibly timestamped when
 * resolution fails), renders the interleaved article in the pane with the
 * PERSISTENT canvas projecting its places — the app's one layout grammar,
 * read-only chrome — and offers "Add these places to my library". No editing
 * controls exist here.
 */
import type { OsmElementRef } from "@placemarks/domain";
import type { SharedGuide } from "@placemarks/schemas";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDexieRepo } from "../../data/RepoContext";
import { DEFAULT_PIN_COLOR } from "../../lib/markers";
import { nowIso } from "../../lib/time";
import { Markdown } from "../../markdown/Markdown";
import { poiResolver } from "../../providers";
import { usePaneStore } from "../../state/pane";
import { useCanvasProjection, useProjectionStore } from "../../state/projection";
import { useUiStore } from "../../state/ui";
import { NavLinks } from "../place/NavLinks";
import { OsmLink } from "../place/OsmLink";
import { articleFollowGroups } from "../posts/articleFollow";
import { resolveAllAnchors, type SharedResolution } from "./resolveShared";
import { type SaveSharedResult, saveSharedGuide } from "./saveSharedGuide";

interface DisplayRow {
  blockId: string;
  kind: "section" | "place";
  title?: string;
  body?: string;
  name?: string;
  category?: string;
  address?: string;
  website?: string;
  lat?: number;
  lng?: number;
  manual?: boolean;
  osmRef?: OsmElementRef;
  observedAt?: string;
  notes?: { title?: string; body: string }[];
  tags?: string[];
}

function rowsOf(guide: SharedGuide): DisplayRow[] {
  return guide.blocks.map((block) => {
    if (block.type === "section") {
      return {
        blockId: block.id,
        kind: "section" as const,
        ...(block.note.title ? { title: block.note.title } : {}),
        body: block.note.body,
      };
    }
    const anchor = block.place;
    const facts = anchor.kind === "osm" ? anchor.lastVerified : anchor;
    return {
      blockId: block.id,
      kind: "place" as const,
      name: anchor.kind === "osm" ? (facts.name ?? "Unnamed place") : anchor.name,
      ...("category" in facts && facts.category ? { category: facts.category } : {}),
      ...(anchor.kind === "osm" && anchor.lastVerified.address
        ? { address: anchor.lastVerified.address }
        : {}),
      ...(anchor.kind === "osm" && anchor.lastVerified.website
        ? { website: anchor.lastVerified.website }
        : {}),
      lat: facts.lat,
      lng: facts.lng,
      manual: anchor.kind === "manual",
      ...(anchor.kind === "osm" ? { osmRef: anchor.currentOsmRef } : {}),
      ...(anchor.kind === "osm" ? { observedAt: anchor.lastVerified.observedAt } : {}),
      ...(block.notes ? { notes: block.notes } : {}),
      ...(block.tags ? { tags: block.tags } : {}),
    };
  });
}

function resolutionLabel(resolution: SharedResolution | undefined): string | undefined {
  switch (resolution?.state) {
    case "live":
      return undefined; // current facts need no caveat
    case "recovered":
      return "OSM element replaced — showing a high-confidence match";
    case "evidence":
      return "live refresh unavailable — showing saved facts";
    case "ambiguous":
      return "OSM element replaced — several possible matches; showing saved facts";
    case "missing":
      return "no longer found on OpenStreetMap — showing saved facts";
    case "manual":
      return undefined; // owner-provided facts carry their own badge
    default:
      // Pending / not yet resolved: copied evidence is never presented as
      // current — it is labeled with its observation time from first paint.
      return "showing saved facts";
  }
}

export function SharedGuideView({
  guide,
  mode,
}: {
  guide: SharedGuide;
  mode: "snapshot" | "hosted";
}) {
  const repo = useDexieRepo();
  const rows = useMemo(() => rowsOf(guide), [guide]);
  const [resolutionState, setResolutionState] = useState<{
    document: SharedGuide;
    values: Record<string, SharedResolution>;
  }>(() => ({ document: guide, values: {} }));
  // Never render one document with another document's live facts while the
  // replacement effect is waiting to run after commit.
  const resolutions = resolutionState.document === guide ? resolutionState.values : {};
  const [saved, setSaved] = useState<SaveSharedResult>();
  const [saving, setSaving] = useState(false);
  // The map and the article are one synchronized view: a pin selects its
  // article entry; activating an entry selects and recentres its pin.
  const articleRef = useRef<HTMLElement>(null);
  const entryRefs = useRef(new Map<string, HTMLLIElement>());
  const [selectedBlockId, setSelectedBlockId] = useState<string>();
  const [visiblePinKeys, setVisiblePinKeys] = useState<string[]>([]);
  const followGroups = useMemo(
    () =>
      articleFollowGroups(
        rows.map((row) => ({
          blockId: row.blockId,
          ...(row.kind === "place" ? { placeId: row.blockId } : {}),
        })),
      ),
    [rows],
  );
  const selectFromMap = useCallback((blockId: string) => {
    setSelectedBlockId(blockId);
    entryRefs.current.get(blockId)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);
  const requestFlyTo = useUiStore((s) => s.requestFlyTo);
  const setSharedSelectHandler = useProjectionStore((s) => s.setSharedSelectHandler);
  const setPane = usePaneStore((s) => s.setPane);
  // The article lands beside its map: the viewer opens at split, and canvas
  // pin taps select article entries for as long as this viewer is mounted.
  useEffect(() => {
    setPane("split");
    setSharedSelectHandler(selectFromMap);
    return () => setSharedSelectHandler(null);
  }, [selectFromMap, setPane, setSharedSelectHandler]);
  const shownCoords = (row: DisplayRow): { lat: number; lng: number } | undefined => {
    // A successful live resolve moves the pin — selection and recentring
    // follow the resolved coordinates, never stale copied ones.
    const live = resolutions[row.blockId];
    const poi = live?.state === "live" || live?.state === "recovered" ? live.poi : undefined;
    if (poi) return { lat: poi.lat, lng: poi.lng };
    return row.lat !== undefined && row.lng !== undefined
      ? { lat: row.lat, lng: row.lng }
      : undefined;
  };
  const selectFromArticle = (row: DisplayRow) => {
    setSelectedBlockId(row.blockId);
    const coords = shownCoords(row);
    if (coords) requestFlyTo({ ...coords, zoom: 16 });
  };

  useEffect(() => {
    // The same viewer instance can receive a newer hosted revision or slug.
    // Reset document-scoped state and ignore late callbacks from the prior
    // document so its coordinates/selection can never leak into the next.
    let currentDocument = true;
    setResolutionState({ document: guide, values: {} });
    setSelectedBlockId(undefined);
    setVisiblePinKeys([]);
    const anchors = new Map(
      guide.blocks.flatMap((block) =>
        block.type === "place" ? [[block.id, block.place] as const] : [],
      ),
    );
    void resolveAllAnchors(poiResolver, anchors, (blockId, resolution) => {
      if (!currentDocument) return;
      setResolutionState((current) => ({
        document: guide,
        values: {
          ...(current.document === guide ? current.values : {}),
          [blockId]: resolution,
        },
      }));
    });
    return () => {
      currentDocument = false;
    };
  }, [guide]);

  // The shared places project onto the persistent canvas (the app's one
  // layout grammar); a successful live resolve moves the pin — the projection
  // follows resolved coordinates, never stale copied ones.
  const pins = rows.flatMap((row) => {
    const coords = row.kind === "place" ? shownCoords(row) : undefined;
    if (!coords) return [];
    return [
      {
        key: row.blockId,
        name: row.name ?? "Place",
        lat: coords.lat,
        lng: coords.lng,
        ...(row.manual ? { unlinked: true } : {}),
        ...(row.blockId === selectedBlockId ? { selected: true } : {}),
      },
    ];
  });

  // Public posts/lists follow the article just like the private reader. The
  // observer is installed after rendered rows exist and is recreated if live
  // resolution moves their coordinates.
  const pinKey = pins
    .map((pin) => `${pin.key}:${pin.lat.toString()}:${pin.lng.toString()}`)
    .join("|");
  const followKey = [...followGroups.entries()]
    .map(([blockId, placeIds]) => `${blockId}:${placeIds.join(",")}`)
    .join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: pinKey is the stable serialization of the pins consumed by this observer.
  useEffect(() => {
    if (!pinKey) return;
    const root = articleRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const visibleBlocks = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const blockId = (entry.target as HTMLElement).dataset.sharedFollow;
          if (!blockId) continue;
          if (entry.isIntersecting) visibleBlocks.add(blockId);
          else visibleBlocks.delete(blockId);
        }
        const next = [
          ...new Set([...visibleBlocks].flatMap((blockId) => followGroups.get(blockId) ?? [])),
        ];
        setVisiblePinKeys((current) =>
          current.length === next.length && current.every((key, index) => key === next[index])
            ? current
            : next,
        );

        // Preserve the existing embed-highlight behavior; prose sections can
        // frame several places without pretending that one card was selected.
        const visiblePlace = entries.find(
          (entry) =>
            entry.isIntersecting && (entry.target as HTMLElement).dataset.sharedPlace !== undefined,
        );
        const placeBlockId = (visiblePlace?.target as HTMLElement | undefined)?.dataset.sharedPlace;
        if (placeBlockId) setSelectedBlockId(placeBlockId);
      },
      { threshold: 0.4 },
    );
    for (const element of root.querySelectorAll("[data-shared-follow]")) observer.observe(element);
    return () => observer.disconnect();
  }, [followGroups, followKey, pinKey]);
  useCanvasProjection({
    kind: "shared",
    pins,
    ...(visiblePinKeys.length > 0 ? { focusKeys: visiblePinKeys } : {}),
  });

  return (
    <div className="h-full" data-testid="shared-guide">
      <article ref={articleRef} className="h-full min-h-0 overflow-y-auto p-4">
        <header className="flex items-start justify-between gap-3">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-stone-900">
            <span
              className="inline-block h-4 w-4 rounded-full"
              style={{ backgroundColor: DEFAULT_PIN_COLOR }}
            />
            {guide.title}
          </h1>
          <button
            type="button"
            disabled={saving || saved !== undefined}
            onClick={() => {
              setSaving(true);
              void saveSharedGuide(repo, poiResolver, guide, nowIso())
                .then(setSaved)
                .finally(() => setSaving(false));
            }}
            className="shrink-0 rounded bg-stone-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            data-testid="save-shared-guide"
          >
            {saved
              ? "Added to your library"
              : saving
                ? "Adding…"
                : "Add these places to my library"}
          </button>
        </header>
        {guide.list ? (
          // A shared post stays associated with its list (spec/src/posts.md
          // §Publishing): named always; a working link when the list has its
          // own hosted page (a tombstoned slug can only 404, never point
          // elsewhere).
          <p className="mt-1 text-sm text-stone-600" data-testid="shared-post-list">
            From the list:{" "}
            {guide.list.slug ? (
              <a
                href={`/l/${guide.list.slug}`}
                className="font-medium text-blue-700 underline"
                data-testid="shared-post-list-link"
              >
                {guide.list.title}
              </a>
            ) : (
              <span className="font-medium">{guide.list.title}</span>
            )}
          </p>
        ) : null}
        <p className="mt-1 text-xs text-stone-500">
          A shared, read-only {guide.kind === "list" ? "list" : "post"}
          {mode === "snapshot" ? " (snapshot link)" : ""}. Map data © OpenStreetMap contributors.
        </p>
        {saved ? (
          <p
            className="mt-2 rounded bg-emerald-50 p-2 text-xs text-emerald-800"
            data-testid="save-result"
          >
            Added {saved.added} places
            {saved.pending > 0 ? `, ${saved.pending} waiting for review in Settings` : ""}
            {saved.duplicates > 0 ? `, ${saved.duplicates} already in your library` : ""}.{" "}
            <Link
              to="/list/$listId"
              params={{ listId: saved.listId }}
              className="font-medium underline"
              data-testid="open-saved-list"
            >
              Open list
            </Link>
          </p>
        ) : null}

        <ol className="mt-4 space-y-3">
          {rows.map((row) => {
            if (row.kind === "section") {
              return (
                <li
                  key={row.blockId}
                  data-shared-follow={row.blockId}
                  className="prose prose-sm prose-stone max-w-none"
                >
                  {row.title ? <h2>{row.title}</h2> : null}
                  <Markdown body={row.body ?? ""} />
                </li>
              );
            }
            // A successful live resolve replaces the copied fallback fields —
            // copied facts render only while live resolution is unavailable.
            const resolution = resolutions[row.blockId];
            const livePoi =
              resolution?.state === "live" || resolution?.state === "recovered"
                ? resolution.poi
                : undefined;
            const shown = livePoi
              ? {
                  name: livePoi.name ?? row.name,
                  category: livePoi.category,
                  address: livePoi.address,
                  website: livePoi.website,
                }
              : {
                  name: row.name,
                  category: row.category,
                  address: row.address,
                  website: row.website,
                };
            return (
              <li
                key={row.blockId}
                ref={(element) => {
                  if (element) entryRefs.current.set(row.blockId, element);
                  else entryRefs.current.delete(row.blockId);
                }}
                data-selected={selectedBlockId === row.blockId ? "true" : "false"}
                data-shared-place={row.blockId}
                data-shared-follow={row.blockId}
                className={`rounded-lg border bg-stone-50 p-3 ${
                  selectedBlockId === row.blockId ? "border-stone-500" : "border-stone-200"
                }`}
                data-testid="shared-place"
              >
                <button
                  type="button"
                  onClick={() => selectFromArticle(row)}
                  className="text-left font-medium text-stone-900 hover:underline"
                >
                  {shown.name}
                </button>
                {shown.category ? (
                  <span className="ml-2 text-xs capitalize text-stone-500">{shown.category}</span>
                ) : null}
                {row.manual ? (
                  <span className="ml-2 rounded bg-orange-100 px-1 text-[10px] text-orange-800">
                    not linked to OSM
                  </span>
                ) : null}
                {shown.address ? (
                  <span className="block text-sm text-stone-600">{shown.address}</span>
                ) : null}
                {(row.tags ?? []).length > 0 ? (
                  <span className="mt-1 flex flex-wrap gap-1" data-testid="shared-place-tags">
                    {(row.tags ?? []).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-stone-200 px-2 py-0.5 text-[11px] text-stone-700"
                      >
                        {tag}
                      </span>
                    ))}
                  </span>
                ) : null}
                {shown.website ? (
                  /^https?:\/\//i.test(shown.website) ? (
                    <a
                      href={shown.website}
                      target="_blank"
                      rel="noopener noreferrer nofollow ugc"
                      className="block text-sm text-blue-700 underline"
                    >
                      {shown.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                    </a>
                  ) : (
                    // A copied website that is not plain http(s) is untrusted
                    // snapshot data — shown, never clickable.
                    <span className="block text-sm text-stone-500">{shown.website}</span>
                  )
                ) : null}
                {resolutionLabel(resolutions[row.blockId]) ? (
                  <span
                    className="mt-1 block text-[11px] text-stone-400"
                    data-testid="resolution-note"
                  >
                    {resolutionLabel(resolutions[row.blockId])}
                    {row.observedAt ? ` (observed ${row.observedAt.slice(0, 10)})` : ""}
                  </span>
                ) : null}
                {(row.notes ?? []).map((note, index) => (
                  <div
                    key={`${row.blockId}-note-${index.toString()}`}
                    className="mt-2 border-t border-stone-200 pt-2"
                  >
                    {note.title ? (
                      <span className="text-xs font-medium text-stone-700">{note.title}</span>
                    ) : null}
                    <Markdown body={note.body} />
                  </div>
                ))}
                {(() => {
                  const coords = shownCoords(row);
                  if (!coords) return null;
                  const osmRef = livePoi?.osmRef ?? row.osmRef;
                  return (
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <NavLinks
                        lat={coords.lat}
                        lng={coords.lng}
                        {...(shown.name ? { name: shown.name } : {})}
                      />
                      {osmRef ? <OsmLink osmRef={osmRef} /> : null}
                    </div>
                  );
                })()}
              </li>
            );
          })}
        </ol>
        <footer className="mt-6 text-[11px] text-stone-400">
          Place facts{" "}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            © OpenStreetMap contributors
          </a>{" "}
          (ODbL). Saved facts are labeled with their observation time when live refresh is
          unavailable.
        </footer>
      </article>
    </div>
  );
}
