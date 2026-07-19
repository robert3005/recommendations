/**
 * The public read-only guide viewer (spec/src/sharing.md §Public guide viewer):
 * paints immediately from copied evidence / manual facts, live-resolves OSM
 * anchors (evidence stays visibly timestamped when resolution fails), renders
 * the interleaved article with a synchronized map, and offers
 * "Add this guide to my library". No editing controls exist here.
 */
import type { SharedGuide } from "@placemarks/schemas";
import { useEffect, useMemo, useRef, useState } from "react";
import { MAP_STYLE_URL } from "../../config";
import { useDexieRepo } from "../../data/RepoContext";
import { DEFAULT_PIN_COLOR } from "../../lib/markers";
import { nowIso } from "../../lib/time";
import { MapView, type PlacePinFeature } from "../../map/MapView";
import { Markdown } from "../../markdown/Markdown";
import { poiResolver } from "../../providers";
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
  observedAt?: string;
  notes?: { title?: string; body: string }[];
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
      ...(anchor.kind === "osm" ? { observedAt: anchor.lastVerified.observedAt } : {}),
      ...(block.notes ? { notes: block.notes } : {}),
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
  const [resolutions, setResolutions] = useState<Record<string, SharedResolution>>({});
  const [saved, setSaved] = useState<SaveSharedResult>();
  const [saving, setSaving] = useState(false);
  const startedRef = useRef(false);
  // The map and the article are one synchronized view: a pin selects its
  // article entry; activating an entry selects and recentres its pin.
  const entryRefs = useRef(new Map<string, HTMLLIElement>());
  const [selectedBlockId, setSelectedBlockId] = useState<string>();
  const [flyTarget, setFlyTarget] = useState<{ lat: number; lng: number; zoom?: number } | null>(
    null,
  );
  const selectFromMap = (blockId: string) => {
    setSelectedBlockId(blockId);
    entryRefs.current.get(blockId)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
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
    if (coords) setFlyTarget({ ...coords, zoom: 16 });
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const anchors = new Map(
      guide.blocks.flatMap((block) =>
        block.type === "place" ? [[block.id, block.place] as const] : [],
      ),
    );
    void resolveAllAnchors(poiResolver, anchors, (blockId, resolution) => {
      setResolutions((current) => ({ ...current, [blockId]: resolution }));
    });
  }, [guide]);

  const pins: PlacePinFeature[] = rows.flatMap((row) => {
    if (row.kind !== "place" || row.lat === undefined || row.lng === undefined) return [];
    const live = resolutions[row.blockId];
    const poi = live?.state === "live" || live?.state === "recovered" ? live.poi : undefined;
    return [
      {
        placeId: row.blockId,
        name: row.name ?? "Place",
        lat: poi?.lat ?? row.lat,
        lng: poi?.lng ?? row.lng,
        unlinked: row.manual === true,
        color: DEFAULT_PIN_COLOR,
      },
    ];
  });

  return (
    <div className="flex h-full flex-col md:flex-row" data-testid="shared-guide">
      <div className="h-64 shrink-0 md:h-auto md:w-1/2">
        <MapView
          styleUrl={MAP_STYLE_URL}
          initialCenter={{
            lat: pins[0]?.lat ?? 20,
            lng: pins[0]?.lng ?? 0,
          }}
          initialZoom={pins.length > 0 ? 12 : 2}
          placePins={pins}
          poiPins={[]}
          selectionPin={(() => {
            const selected = rows.find((row) => row.blockId === selectedBlockId);
            return selected ? (shownCoords(selected) ?? null) : null;
          })()}
          flyTo={flyTarget}
          onSelectPlace={selectFromMap}
        />
      </div>
      <article className="min-h-0 flex-1 overflow-y-auto p-4">
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
            {saved ? "Added to your library" : saving ? "Adding…" : "Add to my library"}
          </button>
        </header>
        <p className="mt-1 text-xs text-stone-500">
          A shared, read-only guide{mode === "snapshot" ? " (snapshot link)" : ""}. Map data ©
          OpenStreetMap contributors.
        </p>
        {saved ? (
          <p
            className="mt-2 rounded bg-emerald-50 p-2 text-xs text-emerald-800"
            data-testid="save-result"
          >
            Added {saved.added} places
            {saved.pending > 0 ? `, ${saved.pending} waiting for review in Settings` : ""}
            {saved.duplicates > 0 ? `, ${saved.duplicates} already in your library` : ""}.
          </p>
        ) : null}

        <ol className="mt-4 space-y-3">
          {rows.map((row) => {
            if (row.kind === "section") {
              return (
                <li key={row.blockId} className="prose prose-sm prose-stone max-w-none">
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
