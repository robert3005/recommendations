/**
 * The share preview (spec/src/sharing.md): before a link exists, list exactly
 * what leaves the device — the actual names, addresses, prose, and copied OSM
 * evidence, not summaries — and the final URL size. Nothing is truncated
 * silently.
 */
import type { SharedGuide } from "@placemarks/schemas";
import type { ProjectionStats } from "./project";
import { SNAPSHOT_COMPRESSED_LIMIT } from "./snapshot";

export interface SharePreviewProps {
  title: string;
  guide: SharedGuide;
  stats: ProjectionStats;
  /** Snapshot link URL when it fits, or the reason it doesn't. */
  snapshotUrl?: string;
  compressedBytes?: number;
  tooLargeReason?: string;
  onCopy: () => void;
  onClose: () => void;
  copied: boolean;
}

export function SharePreview({
  title,
  guide,
  stats,
  snapshotUrl,
  compressedBytes,
  tooLargeReason,
  onCopy,
  onClose,
  copied,
}: SharePreviewProps) {
  // Full disclosure: every copied value that will leave the device, verbatim.
  const evidenceLines = (
    label: string,
    evidence: {
      osmRef: { type: string; id: string };
      osmVersion?: number;
      name?: string;
      category: string;
      lat: number;
      lng: number;
      address?: string;
      website?: string;
      phone?: string;
      stableIds?: Record<string, string>;
      observedAt: string;
      license: string;
    },
  ): string =>
    [
      `${label}: ${evidence.osmRef.type}/${evidence.osmRef.id}`,
      evidence.osmVersion !== undefined ? `v${evidence.osmVersion.toString()}` : undefined,
      evidence.name,
      evidence.category,
      `${evidence.lat.toString()}, ${evidence.lng.toString()}`,
      evidence.address,
      evidence.website,
      evidence.phone,
      // Copied identity records disclose their keys, not just opaque values.
      ...(evidence.stableIds
        ? Object.entries(evidence.stableIds).map(([key, value]) => `${key} ${value}`)
        : []),
      `observed ${evidence.observedAt}`,
      evidence.license,
    ]
      .filter(Boolean)
      .join(" · ");
  const placeRows = guide.blocks.flatMap((block) => {
    if (block.type !== "place") return [];
    const anchor = block.place;
    const lines: string[] =
      anchor.kind === "osm"
        ? [
            `current ref: ${anchor.currentOsmRef.type}/${anchor.currentOsmRef.id}`,
            evidenceLines("first seen", anchor.firstSeen),
            evidenceLines("last verified", anchor.lastVerified),
          ]
        : [
            `manual pin · ${anchor.lat.toString()}, ${anchor.lng.toString()}${
              anchor.category ? ` · ${anchor.category}` : ""
            }`,
          ];
    return [
      {
        id: block.id,
        name: anchor.kind === "osm" ? (anchor.lastVerified.name ?? "Unnamed place") : anchor.name,
        address: anchor.kind === "osm" ? anchor.lastVerified.address : undefined,
        manual: anchor.kind === "manual",
        notes: block.notes ?? [],
        tags: block.tags ?? [],
        lines,
      },
    ];
  });
  const selectedTagCount = placeRows.reduce((total, row) => total + row.tags.length, 0);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss is supplementary; the Close button is the accessible path
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Share ${title}`}
        className="w-full max-w-md rounded-2xl bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={() => {}}
        data-testid="share-preview"
      >
        <h2 className="text-base font-semibold text-stone-900">Share "{title}"</h2>
        <p className="mt-1 text-xs text-stone-500">
          Anyone with the link can read this page. Exactly this leaves your device:
        </p>
        <ul className="mt-2 list-disc pl-5 text-sm text-stone-700" data-testid="share-manifest">
          <li>The list name and place order</li>
          <li>
            {stats.places} place{stats.places === 1 ? "" : "s"} with their saved OSM facts (©
            OpenStreetMap contributors) or manual-pin details
          </li>
          <li>
            {stats.sharedNotes} note{stats.sharedNotes === 1 ? "" : "s"} marked shareable
            {stats.sharedNotes > 0 ? " — private notes stay private" : ""}
          </li>
          {stats.sections > 0 ? <li>{stats.sections} shareable narrative sections</li> : null}
          {stats.imagesOmitted ? (
            <li>
              Images are omitted — the page shows text placeholders instead
              {stats.omittedImages && stats.omittedImages.length > 0 ? (
                <ul className="list-disc pl-4 text-xs text-stone-500">
                  {stats.omittedImages.map((alt, index) => (
                    <li key={`${alt}-${index.toString()}`}>Omitted image: “{alt}”</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ) : null}
          {stats.omittedPlaces > 0 ? (
            <li className="text-orange-700">
              {stats.omittedPlaces} place{stats.omittedPlaces === 1 ? "" : "s"} cannot be shared (no
              facts to share) and will be skipped
            </li>
          ) : null}
          <li>
            {selectedTagCount > 0
              ? `${selectedTagCount.toString()} explicitly selected ${
                  selectedTagCount === 1 ? "tag leaves" : "tags leave"
                } the device and ${selectedTagCount === 1 ? "is" : "are"} named below; unselected tags stay private`
              : "No tags leave the device; non-shareable notes stay private"}
          </li>
        </ul>

        {/* The exact payload, not a summary: every name, address, and shared sentence. */}
        <div
          className="mt-2 max-h-48 overflow-y-auto rounded border border-stone-100 bg-stone-50 p-2"
          data-testid="share-payload"
        >
          <ul className="space-y-1 text-xs text-stone-700">
            {guide.blocks.flatMap((block) =>
              block.type === "section"
                ? [
                    <li key={block.id}>
                      {block.note.title ? (
                        <span className="font-medium">{block.note.title}: </span>
                      ) : null}
                      <span className="text-stone-600">{block.note.body}</span>
                    </li>,
                  ]
                : [],
            )}
            {placeRows.map((row) => (
              <li key={row.id}>
                <span className="font-medium">{row.name}</span>
                {row.address ? <span className="text-stone-500"> — {row.address}</span> : null}
                {row.manual ? <span className="text-orange-700"> (manual pin)</span> : null}
                {row.lines.map((line) => (
                  <span key={line} className="block text-[10px] text-stone-400">
                    {line}
                  </span>
                ))}
                {row.tags.length > 0 ? (
                  <span className="block text-[10px] text-stone-500">
                    Selected tags: {row.tags.join(", ")}
                  </span>
                ) : null}
                {row.notes.map((note, index) => (
                  <blockquote
                    key={`${row.id}-n-${index.toString()}`}
                    className="mt-0.5 border-l-2 border-stone-300 pl-2 text-stone-600"
                  >
                    {note.title ? <span className="font-medium">{note.title}: </span> : null}
                    {note.body}
                  </blockquote>
                ))}
              </li>
            ))}
          </ul>
        </div>

        {snapshotUrl ? (
          <div className="mt-3">
            <p className="text-xs text-stone-500">
              {/* The user shares the URL, so the disclosed size is the URL's. */}
              Link size: {Math.ceil(new TextEncoder().encode(snapshotUrl).byteLength / 1024)} KiB
              (compressed payload {Math.ceil((compressedBytes ?? 0) / 1024)} of{" "}
              {SNAPSHOT_COMPRESSED_LIMIT / 1024} KiB). The page lives entirely in this link — no
              server stores it.
            </p>
            <div className="mt-2 flex gap-2">
              <input
                readOnly
                value={snapshotUrl}
                aria-label="Snapshot link"
                className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1 font-mono text-[11px]"
                data-testid="snapshot-url"
                onFocus={(e) => e.target.select()}
              />
              <button
                type="button"
                onClick={onCopy}
                className="shrink-0 rounded bg-stone-800 px-3 py-1.5 text-sm font-medium text-white"
                data-testid="copy-share-link"
              >
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          </div>
        ) : (
          <p
            className="mt-3 rounded bg-orange-50 p-2 text-xs text-orange-800"
            data-testid="share-too-large"
          >
            {tooLargeReason}
          </p>
        )}

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
