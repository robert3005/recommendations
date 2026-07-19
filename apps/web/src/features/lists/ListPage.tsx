/**
 * A list: read by default; a deliberate **Edit mode** (Phase 3 interop,
 * book/src/interop.md §List curation returns) adds reorder/remove/rename/
 * recolour — imported lists are too large for place-card-only curation.
 * Every list exports as KML / Takeout-shaped CSV / GeoJSON / GPX.
 */
import { displayFacts, type GuideBlockView, type Note } from "@placemarks/domain";
import type { SharedGuide } from "@placemarks/schemas";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useGuide, useGuideBlocks } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { downloadText } from "../../lib/download";
import { DEFAULT_PIN_COLOR } from "../../lib/markers";
import { nowIso } from "../../lib/time";
import {
  type ExportPlaceView,
  exportListCsv,
  exportListGeoJson,
  exportListGpx,
  exportListKml,
} from "../interop/export";
import { StateBadge } from "../place/StateBadge";
import { type ProjectionStats, projectGuide } from "../share/project";
import { SharePreview } from "../share/SharePreview";
import { encodeSnapshot, SnapshotTooLargeError } from "../share/snapshot";
import { MarkerSwatches } from "./MarkerSwatches";

const EXPORTS = [
  { key: "kml", label: "KML", mime: "application/vnd.google-earth.kml+xml", write: exportListKml },
  { key: "csv", label: "CSV", mime: "text/csv", write: exportListCsv },
  { key: "geojson", label: "GeoJSON", mime: "application/geo+json", write: exportListGeoJson },
  { key: "gpx", label: "GPX", mime: "application/gpx+xml", write: exportListGpx },
] as const;

export function ListPage() {
  const { listId } = useParams({ from: "/lists/$listId" });
  const repo = useRepo();
  const navigate = useNavigate();
  const list = useGuide(listId);
  const blocks = useGuideBlocks(listId);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState<string>();
  const [sharing, setSharing] = useState<{
    guide: SharedGuide;
    stats: ProjectionStats;
    snapshotUrl?: string;
    compressedBytes?: number;
    tooLargeReason?: string;
  }>();
  const [copied, setCopied] = useState(false);

  if (!list) return <div className="p-4 text-stone-500">List not found.</div>;

  const openShare = async () => {
    const projection = await projectGuide(repo, list.id);
    if (!projection) return;
    try {
      const { fragment, compressedBytes } = encodeSnapshot(projection.guide);
      setSharing({
        guide: projection.guide,
        stats: projection.stats,
        snapshotUrl: `${window.location.origin}/l#${fragment}`,
        compressedBytes,
      });
    } catch (err) {
      setSharing({
        guide: projection.guide,
        stats: projection.stats,
        tooLargeReason:
          err instanceof SnapshotTooLargeError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err),
      });
    }
    setCopied(false);
  };

  const placeBlocks = (blocks ?? []).filter((v) => v.block.content.type === "place");

  const exportAs = async (writer: (typeof EXPORTS)[number]) => {
    const views: ExportPlaceView[] = [];
    for (const view of placeBlocks) {
      if (!view.place) continue;
      let notes: Note[] = [];
      try {
        notes = await repo.listNotesForPlace(view.place.id);
      } catch {
        notes = [];
      }
      const placeView = await repo.getPlaceView(view.place.id);
      views.push({ place: view.place, notes, tags: placeView?.tags ?? [] });
    }
    const safe = list.name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "list";
    downloadText(`${safe}.${writer.key}`, writer.mime, writer.write(list, views));
  };

  const move = (view: GuideBlockView, direction: -1 | 1) => {
    const index = placeBlocks.findIndex((v) => v.block.id === view.block.id);
    const target = index + direction;
    if (target < 0 || target >= placeBlocks.length) return;
    // moveBlock places the block before the given sibling (null = end).
    const before =
      direction === -1
        ? (placeBlocks[target]?.block.id ?? null)
        : (placeBlocks[target + 1]?.block.id ?? null);
    void repo.moveBlock(view.block.id, before, nowIso());
  };

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="list-page">
      <div className="flex items-start justify-between gap-2">
        {editing ? (
          <div className="min-w-0 flex-1">
            <input
              type="text"
              value={name ?? list.name}
              onChange={(e) => setName(e.target.value)}
              aria-label="List name"
              className="w-full rounded border border-stone-300 px-2 py-1 text-lg font-semibold"
              data-testid="list-name-input"
            />
            <MarkerSwatches
              radioName="list-page-marker"
              selected={list.color ?? DEFAULT_PIN_COLOR}
              onSelect={(color) => {
                void repo.updateList({ ...list, color, updatedAt: nowIso() });
              }}
            />
          </div>
        ) : (
          <h1 className="flex items-center gap-2 text-xl font-semibold text-stone-900">
            <span
              className="inline-block h-4 w-4 rounded-full"
              style={{ backgroundColor: list.color ?? DEFAULT_PIN_COLOR }}
              data-testid="list-marker"
              data-color={list.color ?? DEFAULT_PIN_COLOR}
            />
            {list.name}
          </h1>
        )}
        <button
          type="button"
          className="shrink-0 rounded border border-stone-300 px-3 py-1 text-sm font-medium text-stone-700"
          data-testid="edit-list"
          onClick={() => {
            if (editing) {
              const trimmed = name?.trim();
              if (trimmed && trimmed !== list.name) {
                void repo.updateList({ ...list, name: trimmed, updatedAt: nowIso() });
              }
              setName(undefined);
            }
            setEditing(!editing);
          }}
        >
          {editing ? "Done" : "Edit"}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-500">
        <button
          type="button"
          className="rounded bg-stone-800 px-2.5 py-1 font-medium text-white"
          data-testid="share-list"
          onClick={() => void openShare()}
        >
          Share…
        </button>
        Export:
        {EXPORTS.map((writer) => (
          <button
            key={writer.key}
            type="button"
            className="rounded border border-stone-200 px-2 py-0.5 font-medium text-stone-600 hover:bg-stone-100"
            data-testid={`export-${writer.key}`}
            onClick={() => void exportAs(writer)}
          >
            {writer.label}
          </button>
        ))}
      </div>

      {sharing ? (
        <SharePreview
          title={list.name}
          guide={sharing.guide}
          stats={sharing.stats}
          {...(sharing.snapshotUrl ? { snapshotUrl: sharing.snapshotUrl } : {})}
          {...(sharing.compressedBytes !== undefined
            ? { compressedBytes: sharing.compressedBytes }
            : {})}
          {...(sharing.tooLargeReason ? { tooLargeReason: sharing.tooLargeReason } : {})}
          copied={copied}
          onCopy={() => {
            if (sharing.snapshotUrl) {
              void navigator.clipboard.writeText(sharing.snapshotUrl).then(() => setCopied(true));
            }
          }}
          onClose={() => setSharing(undefined)}
        />
      ) : null}

      <ul className="mt-4 space-y-2">
        {placeBlocks.map((view) => {
          const facts = view.place ? displayFacts(view.place) : undefined;
          return (
            <li
              key={view.block.id}
              className="rounded-lg border border-stone-200 bg-stone-50 p-3"
              data-testid="place-item"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-medium text-stone-900">
                    {facts?.name ?? "Missing place"}
                  </span>
                  {facts?.category ? (
                    <span className="ml-2 text-xs capitalize text-stone-500">{facts.category}</span>
                  ) : null}
                  {view.place ? (
                    <span className="ml-2">
                      <StateBadge state={view.place.resolutionState} />
                    </span>
                  ) : null}
                  {facts?.address ? (
                    <span className="block text-sm text-stone-600">{facts.address}</span>
                  ) : null}
                  {facts?.website ? (
                    <a
                      href={facts.website}
                      target="_blank"
                      rel="noopener noreferrer nofollow ugc"
                      className="block text-sm text-blue-700 underline"
                    >
                      {facts.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                    </a>
                  ) : null}
                </div>
                {editing ? (
                  <span className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      aria-label="Move up"
                      className="rounded px-1.5 py-0.5 text-xs text-stone-600 hover:bg-stone-200"
                      onClick={() => move(view, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label="Move down"
                      className="rounded px-1.5 py-0.5 text-xs text-stone-600 hover:bg-stone-200"
                      onClick={() => move(view, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-xs text-red-700 hover:bg-red-50"
                      data-testid="remove-from-list"
                      onClick={() => void repo.removeBlock(view.block.id, nowIso())}
                    >
                      Remove
                    </button>
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
        {blocks !== undefined && placeBlocks.length === 0 ? (
          <li className="py-4 text-sm text-stone-500">
            Nothing here yet — add places to this list from their cards on the map, or import a file
            in Settings.
          </li>
        ) : null}
      </ul>

      {editing ? (
        <button
          type="button"
          className="mt-6 rounded border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
          data-testid="delete-list"
          onClick={() => {
            void repo.deleteList(list.id, nowIso()).then(() => navigate({ to: "/lists" }));
          }}
        >
          Delete list
        </button>
      ) : null}
    </div>
  );
}
