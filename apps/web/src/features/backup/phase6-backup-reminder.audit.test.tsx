/** Phase 6 recovery: every non-empty local library needs periodic backup reminders. */
import { markerAt } from "@placemarks/domain";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { SettingsPage } from "./SettingsPage";

vi.mock("../interop/ImportSection", () => ({ ImportSection: () => null }));

describe("Phase 6 backup reminder coverage", () => {
  const repos: DexieRepository[] = [];

  afterEach(() => {
    for (const repo of repos) repo.db.close();
    repos.length = 0;
    globalThis.localStorage?.clear();
  });

  it("reminds for an unbacked-up post draft with notes but no place blocks", async () => {
    const repo = new DexieRepository(`phase6-reminder-${crypto.randomUUID()}`);
    repos.push(repo);
    await repo.createList({
      id: "draft-list",
      name: "Draft list",
      marker: markerAt(0),
      createdAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:00:00.000Z",
    });
    // Sections live on posts (2026-07-19 pivot); the section note is local data
    // worth reminding about even before the first place block exists.
    await repo.createPost({
      id: "draft-post",
      title: "Draft post",
      listId: "draft-list",
      createdAt: "2026-07-19T12:00:30.000Z",
      updatedAt: "2026-07-19T12:00:30.000Z",
    });
    await repo.addPostSection(
      "draft-post",
      "A section note that exists only on this device.",
      "2026-07-19T12:01:00.000Z",
    );

    render(
      <RepoProvider repo={repo}>
        <SettingsPage />
      </RepoProvider>,
    );
    // The implementation must react when the asynchronous local-library reads
    // settle; a zero-place count cannot erase the list and section-note data.
    expect(await screen.findByTestId("backup-reminder")).toBeVisible();
  });
});
