/**
 * Mode A viewer route `/l#…` (spec/src/sharing.md): the document lives in the
 * URL fragment — decoded and schema-validated client-side, never sent to any
 * server. Damaged or oversized links get a designed error, not a blank page.
 */
import type { SharedGuide } from "@placemarks/schemas";
import { useEffect, useState } from "react";
import { EmptySharedCanvasProjection } from "../../state/projection";
import { SharedGuideView } from "./SharedGuideView";
import { decodeSnapshot } from "./snapshot";
import { useNoindex } from "./useNoindex";

export function SnapshotViewerPage() {
  const [state, setState] = useState<{ guide?: SharedGuide; error?: string }>({});
  useNoindex();

  useEffect(() => {
    try {
      setState({ guide: decodeSnapshot(window.location.hash.replace(/^#/, "")) });
    } catch (err) {
      setState({ error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  if (state.error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptySharedCanvasProjection />
        <p className="max-w-sm text-center text-sm text-ink-2" data-testid="snapshot-error">
          <span className="font-semibold text-ink">Could not open this shared page.</span>{" "}
          {state.error}
        </p>
      </div>
    );
  }
  if (!state.guide) return <EmptySharedCanvasProjection />;
  return <SharedGuideView guide={state.guide} mode="snapshot" />;
}
