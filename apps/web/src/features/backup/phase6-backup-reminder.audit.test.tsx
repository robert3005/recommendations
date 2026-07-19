/** Phase 6 recovery: every non-empty local library needs periodic backup reminders. */
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

  it("reminds for an unbacked-up guide with notes but no place blocks", async () => {
    const repo = new DexieRepository(`phase6-reminder-${crypto.randomUUID()}`);
    repos.push(repo);
    await repo.createList({
      id: "draft-guide",
      name: "Draft guide",
      createdAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:00:00.000Z",
    });
    await repo.addSectionBlock(
      "draft-guide",
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
