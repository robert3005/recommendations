/**
 * Standalone read-only note page `/n/:slug` (spec/src/notes.md §Publishing a
 * note page): the same bearer-token/revision model as other shared pages;
 * public, noindex.
 */
import { type SharedNote, sharedNoteSchema } from "@placemarks/schemas";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { SHARE_API_URL } from "../../config";
import { Markdown } from "../../markdown/Markdown";
import { poiResolver } from "../../providers";
import { usePaneStore } from "../../state/pane";
import { useCanvasProjection, useProjectionStore } from "../../state/projection";
import { useUiStore } from "../../state/ui";
import { resolveSharedAnchor, type SharedResolution } from "./resolveShared";
import { useNoindex } from "./useNoindex";

export function noteContextLabel(context: SharedNote["context"]): string {
  switch (context.kind) {
    case "post":
      return `From the post "${context.postTitle}"`;
    case "list":
      return `From the list "${context.listTitle}"`;
    case "place":
      return "About a shared place";
  }
}

/** The note's place: copied evidence first, live OSM facts when they resolve. */
function NotePlaceContext({
  anchor,
  resolution,
  onSelect,
}: {
  anchor: Extract<ReturnType<typeof sharedNoteSchema.parse>["context"], { kind: "place" }>["place"];
  resolution: SharedResolution;
  onSelect: () => void;
}) {
  const live =
    resolution.state === "live" || resolution.state === "recovered" ? resolution.poi : undefined;
  const copied = anchor.kind === "osm" ? anchor.lastVerified : undefined;
  const name = live?.name ?? (anchor.kind === "osm" ? copied?.name : anchor.name);
  const address = live?.address ?? copied?.address;
  return (
    <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm">
      <button
        type="button"
        className="font-medium text-stone-900 hover:underline"
        onClick={onSelect}
      >
        {name}
      </button>
      {address ? <span className="block text-stone-600">{address}</span> : null}
      {anchor.kind === "manual" ? (
        <span className="mt-1 block text-[11px] text-stone-400">
          Owner-added pin — not linked to OSM
        </span>
      ) : null}
      {!live && copied ? (
        <span className="mt-1 block text-[11px] text-stone-400">
          {resolution.state === "missing"
            ? `This place is no longer found on OpenStreetMap — showing saved facts (observed ${copied.observedAt.slice(0, 10)})`
            : `showing saved facts (observed ${copied.observedAt.slice(0, 10)})`}
        </span>
      ) : null}
      {anchor.kind === "manual" ? null : (
        <span className="mt-1 block text-[11px] text-stone-400">
          Place facts{" "}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            © OpenStreetMap contributors
          </a>{" "}
          (ODbL)
        </span>
      )}
    </div>
  );
}

export function NoteViewerPage() {
  const { slug } = useParams({ from: "/n/$slug" });
  useNoindex();
  const noteQuery = useQuery({
    queryKey: ["hosted-note", slug],
    queryFn: async ({ signal }) => {
      const response = await fetch(`${SHARE_API_URL}/s/notes/${slug}`, { signal });
      if (response.status === 404) throw new Error("gone");
      if (!response.ok) throw new Error("unavailable");
      return sharedNoteSchema.parse(await response.json());
    },
    retry: 1,
  });
  const [resolution, setResolution] = useState<SharedResolution>({ state: "pending" });
  const [selected, setSelected] = useState(false);
  const placeContextRef = useRef<HTMLDivElement>(null);
  const setSharedSelectHandler = useProjectionStore((state) => state.setSharedSelectHandler);
  const requestFlyTo = useUiStore((state) => state.requestFlyTo);
  const setPane = usePaneStore((state) => state.setPane);
  useEffect(() => setPane("split"), [setPane]);
  const anchor =
    noteQuery.data?.context.kind === "place" ? noteQuery.data.context.place : undefined;
  useEffect(() => {
    setResolution({ state: "pending" });
    if (!anchor) return;
    let cancelled = false;
    void resolveSharedAnchor(poiResolver, anchor).then((result) => {
      if (!cancelled) setResolution(result);
    });
    return () => {
      cancelled = true;
    };
  }, [anchor]);

  const live =
    resolution.state === "live" || resolution.state === "recovered" ? resolution.poi : undefined;
  const copied = anchor?.kind === "osm" ? anchor.lastVerified : anchor;
  const pin =
    anchor && copied
      ? {
          key: "note-place",
          name: live?.name ?? copied.name ?? "Shared place",
          lat: live?.lat ?? copied.lat,
          lng: live?.lng ?? copied.lng,
          ...(anchor.kind === "manual" ? { unlinked: true } : {}),
          ...(selected ? { selected: true } : {}),
        }
      : undefined;
  useCanvasProjection({ kind: "shared", pins: pin ? [pin] : [] });
  useEffect(() => {
    setSharedSelectHandler((key) => {
      if (key !== "note-place") return;
      setSelected(true);
      placeContextRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => setSharedSelectHandler(null);
  }, [setSharedSelectHandler]);

  const selectPlaceContext = () => {
    if (!pin) return;
    setSelected(true);
    requestFlyTo({ lat: pin.lat, lng: pin.lng, zoom: 16 });
  };

  if (noteQuery.isPending) return <p className="p-6 text-sm text-stone-500">Loading note…</p>;
  if (noteQuery.isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-sm text-center text-sm text-stone-600" data-testid="hosted-error">
          <span className="font-semibold text-stone-800">
            {noteQuery.error.message === "gone"
              ? "This note page is no longer available."
              : "Could not load this note."}
          </span>
        </p>
      </div>
    );
  }
  const note = noteQuery.data;
  return (
    <article className="mx-auto max-w-2xl p-6" data-testid="shared-note">
      {note.title ? <h1 className="text-2xl font-semibold text-stone-900">{note.title}</h1> : null}
      <p className="mt-1 text-xs text-stone-500">
        {noteContextLabel(note.context)} · read-only shared page
      </p>
      {note.context.kind === "place" ? (
        <div ref={placeContextRef} data-selected={selected ? "true" : "false"}>
          <NotePlaceContext
            anchor={note.context.place}
            resolution={resolution}
            onSelect={selectPlaceContext}
          />
        </div>
      ) : null}
      <div className="prose prose-sm prose-stone mt-4 max-w-none">
        <Markdown body={note.body} />
      </div>
      <footer className="mt-8 text-[11px] text-stone-400">
        Published {note.publishedAt.slice(0, 10)}. Personal notes are the author's own writing.
      </footer>
    </article>
  );
}
