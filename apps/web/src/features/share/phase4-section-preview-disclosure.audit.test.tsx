import type { SharedGuide } from "@placemarks/schemas";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SharePreview } from "./SharePreview";

describe("Phase 4 section-prose disclosure", () => {
  it("shows the exact shareable section title and prose before generating the link", () => {
    const guide: SharedGuide = {
      v: 1,
      kind: "list",
      title: "Weekend guide",
      blocks: [
        {
          id: "section-1",
          type: "section",
          note: { title: "Before you go", body: "The spare key is under the blue flowerpot." },
        },
      ],
      contentHash: "hash",
    };

    render(
      <SharePreview
        title={guide.title}
        guide={guide}
        stats={{ places: 0, sections: 1, sharedNotes: 0, omittedPlaces: 0, imagesOmitted: false }}
        snapshotUrl="https://app.example/l#fixture"
        compressedBytes={123}
        copied={false}
        onCopy={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const preview = screen.getByTestId("share-preview");
    expect(preview).toHaveTextContent("Before you go");
    expect(preview).toHaveTextContent("The spare key is under the blue flowerpot.");
  });
});
