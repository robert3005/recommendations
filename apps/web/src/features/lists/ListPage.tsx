/**
 * The list page (spec/src/map-view.md §The list page): entries beside the
 * posts sidebar, with Edit mode for curation — reorder, rename, remove,
 * marker swap within free pairs — and the publish and export entry points.
 * The canvas shows the list's places with the rest of the library dimmed.
 */
import type { List, ListEntry, Place, Post } from "@placemarks/domain";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useList, useListEntries, useLists, usePosts, usePostsFor } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { type Blocker, TeardownRefusedError } from "../../data/repo";
import { downloadBytes, downloadText } from "../../lib/download";
import { useCanvasProjection, useSelectionStore } from "../../state/projection";
import {
  exportListGeoJson,
  exportListGpx,
  exportListKml,
  exportListKmz,
  exportListMarkdown,
  splitForMyMaps,
} from "../interop/export";
import { PublishControls } from "../publish/PublishControls";
import { BlockerDialog } from "./BlockerDialog";
import { MarkerGlyph } from "./MarkerGlyph";
import { MarkerSwatches } from "./MarkerSwatches";

const EXPORTS = [
  // First, because it is the one a person reads: name, address, and all three
  // deep links per place — the artefact to paste into a message.
  { key: "md", label: "Text list", mime: "text/markdown", write: exportListMarkdown },
  { key: "kml", label: "KML", mime: "application/vnd.google-earth.kml+xml", write: exportListKml },
  { key: "geojson", label: "GeoJSON", mime: "application/geo+json", write: exportListGeoJson },
  { key: "gpx", label: "GPX", mime: "application/gpx+xml", write: exportListGpx },
] as const;

export function ListPage() {
  const { listId } = useParams({ from: "/list/$listId" });
  const repo = useRepo();
  const navigate = useNavigate();
  const list = useList(listId);
  const rows = useListEntries(listId);
  const posts = usePostsFor({ kind: "list", listId });
  const lists = useLists();
  const allPosts = usePosts();
  // Select AND fly in one call (spec/src/map-view.md §Selection is bidirectional).
  const focusPlace = useSelectionStore((s) => s.focusPlace);
  // The canvas projects this list: its members, the rest dimmed
  // (spec/src/map-view.md §The grammar).
  useCanvasProjection({ kind: "list", listId });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState<string>();
  const [refusal, setRefusal] = useState<{ title: string; blockers: Blocker[] }>();
  const [exportError, setExportError] = useState<string>();

  if (!list) return <div className="p-4 text-ink/60">List not found.</div>;

  const entries: { entry: ListEntry; place: Place }[] = rows ?? [];
  const places = entries.map((row) => row.place);

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

  /** Display names for whatever ids a refusal can cite. */
  const blockerNames = Object.fromEntries([
    ...(allPosts ?? []).map((post: Post) => [post.id, post.title]),
    ...entries.map((row) => [row.place.id, row.place.name]),
  ]) as Record<string, string>;

  const safeName = () =>
    list.name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "list";

  const partName = (chunks: unknown[], index: number) =>
    chunks.length > 1 ? `${list.name} (part ${(index + 1).toString()})` : list.name;
  const partFile = (chunks: unknown[], index: number, ext: string) =>
    chunks.length > 1
      ? `${safeName()}-part${(index + 1).toString()}.${ext}`
      : `${safeName()}.${ext}`;

  /** Every advertised KML/KMZ download is My Maps-compatible: warn-and-split
   *  along the 2,000-feature / 5 MB limits (spec/src/interop.md §Export). */
  const exportKml = () => {
    const chunks = splitForMyMaps(list, places);
    chunks.forEach((chunk, index) => {
      downloadText(
        partFile(chunks, index, "kml"),
        "application/vnd.google-earth.kml+xml",
        exportListKml({ ...list, name: partName(chunks, index) }, chunk),
      );
    });
  };

  const exportKmz = () => {
    const chunks = splitForMyMaps(list, places);
    chunks.forEach((chunk, index) => {
      downloadBytes(
        partFile(chunks, index, "kmz"),
        "application/vnd.google-earth.kmz",
        exportListKmz({ ...list, name: partName(chunks, index) }, chunk),
      );
    });
  };

  const exportAs = (writer: (typeof EXPORTS)[number]) => {
    // Fail closed: a broken artefact is worse than none — errors surface
    // instead of downloading.
    try {
      if (writer.key === "kml") {
        exportKml();
        return;
      }
      downloadText(`${safeName()}.${writer.key}`, writer.mime, writer.write(list, places));
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    }
  };

  const move = (row: { entry: ListEntry }, direction: -1 | 1) => {
    const index = entries.findIndex((r) => r.entry.id === row.entry.id);
    const target = index + direction;
    if (target < 0 || target >= entries.length) return;
    // moveEntry places the entry before the given sibling (null = end).
    const before =
      direction === -1
        ? (entries[target]?.entry.id ?? null)
        : (entries[target + 1]?.entry.id ?? null);
    void repo.moveEntry(row.entry.id, before);
  };

  const newPost = () => {
    void repo.createPost({ kind: "list", listId: list.id }, list.name).then((post) => {
      void navigate({ to: "/post/$postId/edit", params: { postId: post.id } });
    });
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
              className="w-full rounded-crisp border border-hairline bg-paper px-2 py-1 font-display text-lg font-semibold text-ink"
              data-testid="list-name-input"
            />
            {/* Marker change swaps within free pairs (spec/src/data-model.md §Markers). */}
            <MarkerSwatches
              radioName="list-page-marker"
              selected={list.marker}
              used={(lists ?? []).filter((l: List) => l.id !== list.id).map((l: List) => l.marker)}
              onSelect={(marker) => void repo.setListMarker(list.id, marker)}
            />
          </div>
        ) : (
          <h1 className="flex items-center gap-2 font-display text-xl font-semibold tracking-tight text-ink">
            <span data-testid="list-marker" data-color={list.marker.color}>
              <MarkerGlyph marker={list.marker} size={18} />
            </span>
            {list.name}
          </h1>
        )}
        <button
          type="button"
          className="shrink-0 rounded-crisp border border-hairline px-3 py-1 text-sm font-medium text-ink"
          data-testid="edit-list"
          onClick={() => {
            if (editing) {
              const trimmed = name?.trim();
              if (trimmed && trimmed !== list.name) void repo.renameList(list.id, trimmed);
              setName(undefined);
            }
            setEditing(!editing);
          }}
        >
          {editing ? "Done" : "Edit"}
        </button>
      </div>

      {/* Publish entry point (spec/src/sharing.md). */}
      <PublishControls listId={list.id} />

      {/* Export entry points (spec/src/interop.md §Export). */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink/60">
        Export:
        {EXPORTS.map((writer) => (
          <button
            key={writer.key}
            type="button"
            className="rounded-crisp border border-hairline px-2 py-0.5 font-medium text-ink hover:bg-ink/5"
            data-testid={`export-${writer.key}`}
            onClick={() => exportAs(writer)}
          >
            {writer.label}
          </button>
        ))}
        <button
          type="button"
          className="rounded-crisp border border-hairline px-2 py-0.5 font-medium text-ink hover:bg-ink/5"
          data-testid="export-kmz"
          onClick={() => {
            try {
              exportKmz();
            } catch (err) {
              setExportError(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          KMZ
        </button>
      </div>
      {exportError ? (
        <output className="mt-1 block rounded-crisp border border-hairline p-2 text-[11px] text-ink">
          Export failed — nothing was downloaded ({exportError}).
        </output>
      ) : null}
      <p className="mt-1 text-[11px] text-ink/60">
        Google My Maps: Import → choose the KML (large lists split into numbered parts
        automatically). OSM: upload the GeoJSON or KML to uMap (umap.openstreetmap.fr).
      </p>

      {/* The posts sidebar (spec/src/map-view.md §The list page): this list's
          posts, with New post — a list post about this list. */}
      <section className="mt-4 border-t border-hairline pt-3" id="posts" data-testid="list-posts">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold text-ink">Posts</h2>
          <button
            type="button"
            className="rounded-crisp border border-hairline px-2.5 py-1 text-xs font-medium text-ink"
            data-testid="new-post"
            onClick={newPost}
          >
            + New post
          </button>
        </div>
        {(posts ?? []).length > 0 ? (
          <ul className="mt-1.5 space-y-1">
            {(posts ?? []).map((post: Post) => (
              <li key={post.id}>
                <button
                  type="button"
                  className="text-sm font-medium text-ink underline"
                  data-testid="list-post-link"
                  onClick={() =>
                    void navigate({ to: "/post/$postId", params: { postId: post.id } })
                  }
                >
                  ✍ {post.title}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-ink/60">
            No posts yet — a post is the article about this list.
          </p>
        )}
      </section>

      <ul className="mt-4 space-y-2">
        {entries.map((row) => (
          <li
            key={row.entry.id}
            className="rounded-crisp border border-hairline p-3"
            data-testid="place-item"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                {/* Selection is bidirectional (spec/src/map-view.md): select
                    in the notebook → the canvas highlights and flies. */}
                <button
                  type="button"
                  className="text-left font-medium text-ink hover:underline"
                  data-testid="select-place"
                  onClick={() => focusPlace(row.place.id)}
                >
                  {row.place.name}
                </button>
                {row.place.category ? (
                  <span className="ml-2 text-xs capitalize text-ink/60">{row.place.category}</span>
                ) : null}
                {row.place.address ? (
                  <span className="block text-sm text-ink/70">{row.place.address}</span>
                ) : null}
              </div>
              {editing ? (
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    aria-label="Move up"
                    className="rounded-crisp px-1.5 py-0.5 text-xs text-ink hover:bg-ink/10"
                    onClick={() => move(row, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    className="rounded-crisp px-1.5 py-0.5 text-xs text-ink hover:bg-ink/10"
                    onClick={() => move(row, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="rounded-crisp px-1.5 py-0.5 text-xs text-accent-vermilion-deep hover:bg-ink/5"
                    data-testid="remove-from-list"
                    onClick={() =>
                      // Last membership deletes the place — refused while
                      // posts target it (spec/src/data-model.md §Teardown).
                      guarded("Can’t remove this place yet", () => repo.removeEntry(row.entry.id))
                    }
                  >
                    Remove
                  </button>
                </span>
              ) : null}
            </div>
          </li>
        ))}
        {rows !== undefined && entries.length === 0 ? (
          <li className="py-4 text-sm text-ink/60">
            Nothing here yet — paste a link or search on the home page, or import a Takeout archive
            in Settings.
          </li>
        ) : null}
      </ul>

      {editing ? (
        <div className="mt-6">
          <button
            type="button"
            className="rounded-crisp border border-hairline px-3 py-1.5 text-sm font-medium text-accent-vermilion-deep hover:bg-ink/5"
            data-testid="delete-list"
            onClick={() =>
              guarded("Can’t delete this list yet", () =>
                repo.deleteList(list.id).then(() => {
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
          names={blockerNames}
          onClose={() => setRefusal(undefined)}
        />
      ) : null}
    </div>
  );
}
