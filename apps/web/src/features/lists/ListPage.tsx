/**
 * A list: read by default; a deliberate **Edit mode** (Phase 3 interop,
 * spec/src/interop.md §List curation returns) adds reorder/remove/rename/
 * recolour — imported lists are too large for place-card-only curation.
 * Every list exports as KML / Takeout-shaped CSV / GeoJSON / GPX.
 */
import {
  displayFacts,
  type ListBlockView,
  type Note,
  type TeardownBlockers,
  TeardownRefusedError,
} from "@placemarks/domain";
import type { SharedGuide } from "@placemarks/schemas";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useList, useListBlocks, useLists, usePostsForList } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { downloadBytes, downloadText } from "../../lib/download";
import { newId } from "../../lib/id";
import { nowIso } from "../../lib/time";
import { useCanvasProjection } from "../../state/projection";
import { useUiStore } from "../../state/ui";
import {
  type ExportPlaceView,
  exportListCsv,
  exportListGeoJson,
  exportListGpx,
  exportListKml,
  exportListKmz,
} from "../interop/export";
import { StateBadge } from "../place/StateBadge";
import { PublishControls } from "../publish/PublishControls";
import { type ProjectionStats, projectList } from "../share/project";
import { SharePreview } from "../share/SharePreview";
import { encodeSnapshot, SnapshotTooLargeError } from "../share/snapshot";
import { BlockerDialog } from "./BlockerDialog";
import { MarkerGlyph } from "./MarkerGlyph";
import { MarkerSwatches } from "./MarkerSwatches";

const EXPORTS = [
  { key: "kml", label: "KML", mime: "application/vnd.google-earth.kml+xml", write: exportListKml },
  { key: "csv", label: "CSV", mime: "text/csv", write: exportListCsv },
  { key: "geojson", label: "GeoJSON", mime: "application/geo+json", write: exportListGeoJson },
  { key: "gpx", label: "GPX", mime: "application/gpx+xml", write: exportListGpx },
] as const;

export function ListPage() {
  const { listId } = useParams({ from: "/list/$listId" });
  const repo = useRepo();
  const navigate = useNavigate();
  const list = useList(listId);
  const blocks = useListBlocks(listId);
  const lists = useLists();
  const selectPlace = useUiStore((s) => s.selectPlace);
  const requestFlyTo = useUiStore((s) => s.requestFlyTo);
  const posts = usePostsForList(listId);
  // The canvas projects this list: its members, the rest dimmed
  // (spec/src/map-view.md §The grammar).
  useCanvasProjection({ kind: "list", listId });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState<string>();
  const [refusal, setRefusal] = useState<{ title: string; blockers: TeardownBlockers }>();
  const [sharing, setSharing] = useState<{
    guide: SharedGuide;
    stats: ProjectionStats;
    snapshotUrl?: string;
    compressedBytes?: number;
    tooLargeReason?: string;
  }>();
  const [copied, setCopied] = useState(false);
  const [exportError, setExportError] = useState<string>();

  if (!list) return <div className="p-4 text-stone-500">List not found.</div>;

  /** Teardown refusals surface as an actionable blocker report, never a crash. */
  const guarded = (title: string, action: () => Promise<void>) => {
    action().catch((err: unknown) => {
      if (err instanceof TeardownRefusedError) {
        setRefusal({ title, blockers: err.blockers });
        return;
      }
      throw err;
    });
  };

  const openShare = async () => {
    const projection = await projectList(repo, list.id);
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

  const placeBlocks = blocks ?? [];
  const blockerPlaceNames = Object.fromEntries(
    placeBlocks.map((view) => [view.place.id, displayFacts(view.place)?.name ?? "Unnamed place"]),
  );

  // Fail closed: a portable export with silently missing notes is worse than
  // no export — read errors abort the download and surface instead.
  const collectViews = async (): Promise<ExportPlaceView[]> => {
    const views: ExportPlaceView[] = [];
    for (const view of placeBlocks) {
      const notes: Note[] = await repo.listNotesForPlace(view.place.id);
      const placeView = await repo.getPlaceView(view.place.id);
      views.push({ place: view.place, notes, tags: placeView?.tags ?? [] });
    }
    return views;
  };

  const safeName = () =>
    list.name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "list";

  /**
   * My Maps accepts ≤2,000 features per layer AND ≤5 MB per file — larger
   * lists split into parts along whichever limit binds first.
   */
  const MY_MAPS_LAYER_LIMIT = 2000;
  const MY_MAPS_FILE_LIMIT = 5 * 1024 * 1024;
  const chunkedViews = async (): Promise<ExportPlaceView[][]> => {
    const views = await collectViews();
    const byCount: ExportPlaceView[][] = [];
    for (let i = 0; i < views.length; i += MY_MAPS_LAYER_LIMIT) {
      byCount.push(views.slice(i, i + MY_MAPS_LAYER_LIMIT));
    }
    if (byCount.length === 0) byCount.push([]);
    const chunks: ExportPlaceView[][] = [];
    // Measure with the LONGEST name a downloaded part can carry — the
    // " (part N)" suffix is applied after splitting, and a boundary chunk
    // measured under the bare name could exceed the limit once renamed.
    const fits = (chunk: ExportPlaceView[]): boolean =>
      new TextEncoder().encode(exportListKml({ ...list, name: `${list.name} (part 999)` }, chunk))
        .byteLength <= MY_MAPS_FILE_LIMIT;
    const bySize = (chunk: ExportPlaceView[]): void => {
      if (fits(chunk)) {
        chunks.push(chunk);
        return;
      }
      if (chunk.length <= 1) {
        // A single feature cannot be split — refusing beats emitting a file
        // My Maps will reject.
        throw new Error(
          "one place's notes exceed the 5 MB My Maps file limit — trim the note and retry",
        );
      }
      const mid = Math.ceil(chunk.length / 2);
      bySize(chunk.slice(0, mid));
      bySize(chunk.slice(mid));
    };
    for (const chunk of byCount) bySize(chunk);
    return chunks;
  };
  const partName = (chunks: unknown[], index: number) =>
    chunks.length > 1 ? `${list.name} (part ${(index + 1).toString()})` : list.name;
  const partFile = (chunks: unknown[], index: number, ext: string) =>
    chunks.length > 1
      ? `${safeName()}-part${(index + 1).toString()}.${ext}`
      : `${safeName()}.${ext}`;

  /** The guided My Maps handoff: KML download(s) sized to the layer limit. */
  const sendToMyMaps = async () => {
    const chunks = await chunkedViews();
    chunks.forEach((chunk, index) => {
      downloadText(
        partFile(chunks, index, "kml"),
        "application/vnd.google-earth.kml+xml",
        exportListKml({ ...list, name: partName(chunks, index) }, chunk),
      );
    });
  };

  const exportKmz = async () => {
    const chunks = await chunkedViews();
    chunks.forEach((chunk, index) => {
      downloadBytes(
        partFile(chunks, index, "kmz"),
        "application/vnd.google-earth.kmz",
        exportListKmz({ ...list, name: partName(chunks, index) }, chunk),
      );
    });
  };

  const exportAs = async (writer: (typeof EXPORTS)[number]) => {
    // Every advertised KML export is My Maps-compatible: the direct button
    // applies the same layer/file-size splitting as the guided handoff.
    if (writer.key === "kml") {
      await sendToMyMaps();
      return;
    }
    const views = await collectViews();
    downloadText(`${safeName()}.${writer.key}`, writer.mime, writer.write(list, views));
  };

  const move = (view: ListBlockView, direction: -1 | 1) => {
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
              selected={list.marker}
              used={(lists ?? []).filter((l) => l.id !== list.id).map((l) => l.marker)}
              onSelect={(marker) => {
                void repo.updateList({ ...list, marker, updatedAt: nowIso() });
              }}
            />
          </div>
        ) : (
          <h1 className="flex items-center gap-2 text-xl font-semibold text-stone-900">
            <span data-testid="list-marker" data-color={list.marker.color}>
              <MarkerGlyph marker={list.marker} size={18} />
            </span>
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
        <button
          type="button"
          className="rounded border border-stone-200 px-2 py-0.5 font-medium text-stone-600 hover:bg-stone-100"
          data-testid="send-to-my-maps"
          onClick={() =>
            void sendToMyMaps().catch((err: unknown) =>
              setExportError(err instanceof Error ? err.message : String(err)),
            )
          }
        >
          Send to Google My Maps
        </button>
        Export:
        {EXPORTS.map((writer) => (
          <button
            key={writer.key}
            type="button"
            className="rounded border border-stone-200 px-2 py-0.5 font-medium text-stone-600 hover:bg-stone-100"
            data-testid={`export-${writer.key}`}
            onClick={() =>
              void exportAs(writer).catch((err: unknown) =>
                setExportError(err instanceof Error ? err.message : String(err)),
              )
            }
          >
            {writer.label}
          </button>
        ))}
        <button
          type="button"
          className="rounded border border-stone-200 px-2 py-0.5 font-medium text-stone-600 hover:bg-stone-100"
          data-testid="export-kmz"
          onClick={() =>
            void exportKmz().catch((err: unknown) =>
              setExportError(err instanceof Error ? err.message : String(err)),
            )
          }
        >
          KMZ
        </button>
      </div>
      {exportError ? (
        <output className="mt-1 block rounded bg-orange-50 p-2 text-[11px] text-orange-800">
          Export failed — nothing was downloaded ({exportError}).
        </output>
      ) : null}
      <p className="mt-1 text-[11px] text-stone-400">
        Google My Maps accepts up to 2,000 features per layer and 5 MB per file — larger lists split
        into numbered parts automatically. Then: My Maps → Import → choose this file.
      </p>
      <PublishControls listId={list.id} />

      {/* The editorial layer (spec/src/posts.md): a list may have several
          posts; the list page links to them and each post links back. */}
      <section className="mt-4" id="posts" data-testid="list-posts">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-stone-700">Posts</h2>
          <button
            type="button"
            className="rounded border border-stone-300 px-2.5 py-1 text-xs font-medium text-stone-700"
            data-testid="new-post"
            onClick={() => {
              const postId = newId();
              const now = nowIso();
              void repo
                .createPost({
                  id: postId,
                  title: list.name,
                  listId: list.id,
                  createdAt: now,
                  updatedAt: now,
                })
                .then(() => navigate({ to: "/post/$postId/edit", params: { postId } }));
            }}
          >
            + New post
          </button>
        </div>
        {(posts ?? []).length > 0 ? (
          <ul className="mt-1.5 space-y-1">
            {(posts ?? []).map((post) => (
              <li key={post.id}>
                <button
                  type="button"
                  className="text-sm font-medium text-blue-700 underline"
                  data-testid="list-post-link"
                  onClick={() => {
                    void navigate({ to: "/post/$postId", params: { postId: post.id } });
                  }}
                >
                  ✍ {post.title}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-stone-400">
            No posts yet — a post is an article about this list.
          </p>
        )}
      </section>

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
                  {/* Selection is bidirectional (spec/src/map-view.md): select
                      in the pane → the canvas highlights and flies. */}
                  <button
                    type="button"
                    className="text-left font-medium text-stone-900 hover:underline"
                    data-testid="select-place"
                    onClick={() => {
                      selectPlace(view.place.id);
                      if (facts) requestFlyTo({ lat: facts.lat, lng: facts.lng, zoom: 16 });
                    }}
                  >
                    {facts?.name ?? "Missing place"}
                  </button>
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
                      onClick={() =>
                        guarded("Can’t remove this place yet", () =>
                          repo.removeBlock(view.block.id, nowIso()),
                        )
                      }
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
        <div className="mt-6 flex items-center gap-2">
          <button
            type="button"
            className="rounded border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
            data-testid="remove-all-places"
            onClick={() =>
              guarded("Can’t empty this list yet", () => repo.removeAllPlaces(list.id, nowIso()))
            }
          >
            Remove all places
          </button>
          <button
            type="button"
            className="rounded border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
            data-testid="delete-list"
            onClick={() =>
              guarded("Can’t delete this list yet", () =>
                repo.deleteList(list.id, nowIso()).then(() => {
                  void navigate({ to: "/" });
                }),
              )
            }
          >
            Delete list
          </button>
        </div>
      ) : null}

      {refusal ? (
        <BlockerDialog
          title={refusal.title}
          blockers={refusal.blockers}
          placeNames={blockerPlaceNames}
          onOpenPlace={(placeId) => {
            const blocked = placeBlocks.find((view) => view.place.id === placeId);
            const facts = blocked ? displayFacts(blocked.place) : undefined;
            setRefusal(undefined);
            selectPlace(placeId);
            if (facts) requestFlyTo({ lat: facts.lat, lng: facts.lng, zoom: 16 });
          }}
          onClose={() => setRefusal(undefined)}
        />
      ) : null}
    </div>
  );
}
