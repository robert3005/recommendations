import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RepoProvider } from "../data/RepoContext";
import { DexieRepository } from "../data/repo";
import { Markdown } from "./Markdown";

describe("local Markdown images", () => {
  it("resolves an asset: image from IndexedDB", async () => {
    const repo = new DexieRepository(`markdown-asset-${crypto.randomUUID()}`);
    try {
      await repo.putMedia(
        {
          id: "media-1",
          mime: "image/webp",
          localBlobKey: "blob-1",
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
        new Blob(["image bytes"], { type: "image/webp" }),
      );

      render(
        <RepoProvider repo={repo}>
          <Markdown body="![Sunset](asset:media-1)" />
        </RepoProvider>,
      );

      expect(await screen.findByRole("img", { name: "Sunset" })).toBeInTheDocument();
    } finally {
      repo.db.close();
    }
  });
});
