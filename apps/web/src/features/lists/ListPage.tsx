/**
 * The list page (spec/src/map-view.md §The list page): the entries are the
 * centre of the page — full-width rows, the whole row one selection target —
 * with Edit mode for curation (reorder, rename, remove, marker swap within
 * free pairs), the publish entry point, and every export behind the one
 * Export menu. Posts are the page's quiet alternate view: a deliberately
 * unaccented Places/Posts toggle under the header swaps the entries for the
 * list's posts (2026-07-26 — search-first chrome). The canvas shows the
 * list's places with the library dimmed.
 */
import type { List, ListEntry, Place, Post } from "@placemarks/domain";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
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

export interface ExportMenuItem {
  testid: string;
  label: string;
  run: () => void;
}

/**
 * The one export entry point (spec/src/map-view.md §The list page): a single
 * "Export" button opening an ARIA menu of the artefact downloads plus the
 * guided handoffs. Roving focus; arrow keys move, Home/End jump, Escape and
 * outside click close. Exported for its unit tests.
 */
export function ExportMenu({
  artefacts,
  handoffs,
}: {
  artefacts: ExportMenuItem[];
  handoffs: ExportMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();
  const menuId = `${baseId}-menu`;
  const handoffLabelId = `${baseId}-handoffs`;
  const items = [...artefacts, ...handoffs];

  // Roving focus: the active item is the one tab stop and holds real focus.
  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  // Clicking outside closes without activating anything.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        rootRef.current &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const openAt = (index: number) => {
    setActive(index);
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const activate = (item: ExportMenuItem) => {
    close(true);
    item.run();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((active + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((active - 1 + items.length) % items.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(items.length - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  const menuItem = (item: ExportMenuItem, index: number) => (
    <button
      key={item.testid}
      ref={(el) => {
        itemRefs.current[index] = el;
      }}
      type="button"
      role="menuitem"
      tabIndex={index === active ? 0 : -1}
      className="block w-full px-3 py-1.5 text-left text-sm text-ink hover:bg-hover"
      data-testid={item.testid}
      onClick={() => activate(item)}
      onMouseEnter={() => setActive(index)}
    >
      {item.label}
    </button>
  );

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="rounded-pill border border-hairline px-3 py-1 text-sm font-medium text-ink hover:bg-hover"
        data-testid="export-menu"
        onClick={() => {
          if (open) close(false);
          else openAt(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openAt(0);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            openAt(items.length - 1);
          }
        }}
      >
        Export ▾
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Export"
          className="absolute top-full right-0 z-30 mt-1 w-56 rounded-crisp border border-hairline bg-panel py-1 shadow-lift"
          onKeyDown={onMenuKeyDown}
        >
          {artefacts.map((item, index) => menuItem(item, index))}
          {/* biome-ignore lint/a11y/useSemanticElements: role=group is the ARIA pattern for a labelled section inside role=menu — a fieldset is not valid menu content */}
          <div
            role="group"
            aria-labelledby={handoffLabelId}
            className="mt-1 border-t border-hairline pt-1"
          >
            <p id={handoffLabelId} className="label-mono px-3 pt-1 pb-0.5 text-ink/60">
              Guided handoffs
            </p>
            {handoffs.map((item, index) => menuItem(item, artefacts.length + index))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export type ListView = "places" | "posts";

/**
 * The quiet Places/Posts view toggle (spec/src/map-view.md §The list page):
 * deliberately unaccented muted text tabs — pressed-state buttons, keyboard
 * operable by nature. Exported for its unit tests.
 */
export function ListViewToggle({
  view,
  onChange,
}: {
  view: ListView;
  onChange: (view: ListView) => void;
}) {
  const tab = (key: ListView, label: string) => (
    <button
      type="button"
      aria-pressed={view === key}
      data-testid={`list-view-${key}`}
      onClick={() => onChange(key)}
      className={
        view === key
          ? "text-ink underline decoration-hairline underline-offset-4"
          : "text-ink/60 hover:text-ink"
      }
    >
      {label}
    </button>
  );
  return (
    <div className="mt-3 flex items-center gap-3 text-sm" data-testid="list-view-toggle">
      {tab("places", "Places")}
      {tab("posts", "Posts")}
    </div>
  );
}

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
  const [view, setView] = useState<ListView>("places");
  const [name, setName] = useState<string>();
  const [refusal, setRefusal] = useState<{ title: string; blockers: Blocker[] }>();
  const [exportError, setExportError] = useState<string>();
  const [handoffHint, setHandoffHint] = useState<string>();

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

  /** Fail closed: a broken artefact is worse than none — errors surface
   *  instead of downloading. */
  const runExport = (action: () => void) => {
    setExportError(undefined);
    setHandoffHint(undefined);
    try {
      action();
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    }
  };

  /** The menu's artefact downloads, KMZ beside its sibling KML. */
  const artefactItems: ExportMenuItem[] = EXPORTS.flatMap((writer) =>
    writer.key === "kml"
      ? [
          { testid: "export-kml", label: writer.label, run: () => runExport(exportKml) },
          { testid: "export-kmz", label: "KMZ", run: () => runExport(exportKmz) },
        ]
      : [
          {
            testid: `export-${writer.key}`,
            label: writer.label,
            run: () =>
              runExport(() => {
                downloadText(
                  `${safeName()}.${writer.key}`,
                  writer.mime,
                  writer.write(list, places),
                );
              }),
          },
        ],
  );

  /** The guided handoffs (spec/src/interop.md §Export): download the right
   *  artefact and say what to do with it. */
  const handoffItems: ExportMenuItem[] = [
    {
      testid: "handoff-my-maps",
      label: "Google My Maps",
      run: () =>
        runExport(() => {
          exportKml();
          setHandoffHint(
            "KML downloaded — in Google My Maps choose Import and pick the file. Large lists split into numbered parts automatically.",
          );
        }),
    },
    {
      testid: "handoff-umap",
      label: "uMap (OSM)",
      run: () =>
        runExport(() => {
          downloadText(
            `${safeName()}.geojson`,
            "application/geo+json",
            exportListGeoJson(list, places),
          );
          setHandoffHint(
            "GeoJSON downloaded — upload it to uMap (umap.openstreetmap.fr) to publish on OSM.",
          );
        }),
    },
  ];

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
      {/* One compact header row: the title and the secondary controls —
          the Export menu and the Edit toggle (spec/src/map-view.md §The list
          page). The entries below get the room. */}
      <div className="flex items-start justify-between gap-2">
        {editing ? (
          <div className="min-w-0 flex-1">
            <input
              type="text"
              value={name ?? list.name}
              onChange={(e) => setName(e.target.value)}
              aria-label="List name"
              className="w-full rounded-pill border border-hairline bg-paper px-2 py-1 font-display text-lg font-semibold text-ink"
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
          <h1 className="flex min-w-0 items-center gap-2 font-display text-[2.25rem] leading-none font-semibold tracking-tight text-ink">
            <span data-testid="list-marker" data-color={list.marker.color}>
              <MarkerGlyph marker={list.marker} size={18} />
            </span>
            <span className="truncate">{list.name}</span>
          </h1>
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Every export lives behind this one menu (spec/src/interop.md §Export). */}
          <ExportMenu artefacts={artefactItems} handoffs={handoffItems} />
          <button
            type="button"
            className="rounded-pill border border-hairline px-3 py-1 text-sm font-medium text-ink"
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
      </div>

      {/* Posts are a quiet ALTERNATE VIEW of the list (spec/src/map-view.md
          §The list page): muted tabs, no accent — the entries stay the
          default centre of the page. */}
      <ListViewToggle view={view} onChange={setView} />

      {/* Publish entry point (spec/src/sharing.md). */}
      <PublishControls listId={list.id} />

      {exportError ? (
        <output className="mt-2 block rounded-crisp border border-hairline p-2 text-[11px] text-ink">
          Export failed — nothing was downloaded ({exportError}).
        </output>
      ) : null}
      {handoffHint ? (
        <output
          className="mt-2 block rounded-crisp border border-hairline p-2 text-[11px] text-ink"
          data-testid="handoff-hint"
        >
          {handoffHint}
        </output>
      ) : null}

      {/* The entries are the visual centre: full-width rows, the whole row one
          selection target (spec/src/map-view.md §The list page). */}
      {view === "places" ? (
        <ul className="mt-5 divide-y divide-hairline border-y border-hairline">
          {entries.map((row) => (
            <li key={row.entry.id} className="flex items-stretch gap-1" data-testid="place-item">
              {/* Selection is bidirectional (spec/src/map-view.md): activate the
                row in the notebook → the canvas highlights and flies. */}
              <button
                type="button"
                className="min-w-0 flex-1 px-2 py-3 text-left hover:bg-hover"
                data-testid="select-place"
                onClick={() => focusPlace(row.place.id)}
              >
                <span className="font-medium text-ink">{row.place.name}</span>
                {row.place.category ? (
                  <span className="ml-2 text-xs text-ink/60 capitalize">{row.place.category}</span>
                ) : null}
                {row.place.address ? (
                  <span className="mt-0.5 block text-sm text-ink/70">{row.place.address}</span>
                ) : null}
              </button>
              {editing ? (
                <span className="flex shrink-0 items-center gap-1 pr-1">
                  <button
                    type="button"
                    aria-label="Move up"
                    className="rounded-pill px-1.5 py-0.5 text-xs text-ink hover:bg-hover"
                    onClick={(e) => {
                      e.stopPropagation();
                      move(row, -1);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    className="rounded-pill px-1.5 py-0.5 text-xs text-ink hover:bg-hover"
                    onClick={(e) => {
                      e.stopPropagation();
                      move(row, 1);
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="rounded-pill px-1.5 py-0.5 text-xs text-accent-vermilion-deep hover:bg-hover"
                    data-testid="remove-from-list"
                    onClick={(e) => {
                      e.stopPropagation();
                      // Last membership deletes the place — refused while
                      // posts target it (spec/src/data-model.md §Teardown).
                      guarded("Can’t remove this place yet", () => repo.removeEntry(row.entry.id));
                    }}
                  >
                    Remove
                  </button>
                </span>
              ) : null}
            </li>
          ))}
          {rows !== undefined && entries.length === 0 ? (
            <li className="px-2 py-4 text-sm text-ink/60">
              Nothing here yet — paste a link or search in the top bar, or import a Takeout archive
              in Settings.
            </li>
          ) : null}
        </ul>
      ) : null}

      {view === "places" && editing ? (
        <div className="mt-6">
          <button
            type="button"
            className="rounded-pill border border-hairline px-3 py-1.5 text-sm font-medium text-accent-vermilion-deep hover:bg-hover"
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

      {/* The Posts view (spec/src/map-view.md §The list page): this list's
          posts, with New post — a list post about this list. Selecting one
          still opens the split reading view. */}
      {view === "posts" ? (
        <section className="mt-5 border-y border-hairline py-3" data-testid="list-posts">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-ink">Posts</h2>
            <button
              type="button"
              className="rounded-pill border border-hairline px-2.5 py-1 text-xs font-medium text-ink"
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
