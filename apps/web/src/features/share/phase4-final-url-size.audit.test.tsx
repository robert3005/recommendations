import type { SharedGuide } from "@placemarks/schemas";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SharePreview } from "./SharePreview";

describe("Phase 4 final snapshot URL disclosure", () => {
  it("reports the final URL size rather than only the compressed payload size", () => {
    const guide: SharedGuide = {
      v: 1,
      kind: "list",
      title: "URL size guide",
      blocks: [],
      contentHash: "hash",
    };
    const compressedBytes = 800;
    // Base64url expands a compressed payload by roughly 4/3, before the route itself.
    const snapshotUrl = `https://app.example/l#${"a".repeat(Math.ceil((compressedBytes * 4) / 3))}`;
    const finalKiB = Math.ceil(new TextEncoder().encode(snapshotUrl).byteLength / 1024);

    render(
      <SharePreview
        title={guide.title}
        guide={guide}
        stats={{ places: 0, sections: 0, sharedNotes: 0, omittedPlaces: 0, imagesOmitted: false }}
        snapshotUrl={snapshotUrl}
        compressedBytes={compressedBytes}
        copied={false}
        onCopy={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("share-preview")).toHaveTextContent(`Link size: ${finalKiB} KiB`);
  });
});
