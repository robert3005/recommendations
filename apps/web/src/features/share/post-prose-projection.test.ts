/**
 * A post publishes its prose (spec/src/posts.md §Publishing). The unit of
 * privacy is the POST: sections travel because the post travels.
 *
 * Regression: `addPostSection` writes its section note with `shareable: false`
 * — the flag is the *place*-note opt-in and means nothing on a post note — and
 * `projectPost` used to skip any section whose note was not shareable. Between
 * them, publishing a post produced an article with its embeds and no prose at
 * all, which is the product's headline feature missing from its own output.
 */
import { markerAt } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { projectPost } from "./project";

const NOW = "2026-07-20T10:00:00.000Z";

function repoFor(label: string): DexieRepository {
  return new DexieRepository(`${label}-${crypto.randomUUID()}`);
}

async function seededPost(repo: DexieRepository): Promise<void> {
  await repo.createList({
    id: "list-1",
    name: "Lisbon eats",
    marker: markerAt(0),
    createdAt: NOW,
    updatedAt: NOW,
  });
  const { place } = await repo.addToList(
    "list-1",
    { kind: "manual", facts: { name: "Cervejaria Ramiro", lat: 38.7208, lng: -9.135 } },
    NOW,
  );
  await repo.createPost({
    id: "post-1",
    title: "Two days of eating in Lisbon",
    listId: "list-1",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.addPostSection("post-1", "Everyone sends you the same three restaurants.", NOW);
  await repo.embedPlaceInPost("post-1", place.id, NOW);
  await repo.addPostSection("post-1", "Day two starts west.", NOW);
}

describe("post prose projection", () => {
  it("publishes every section the author wrote, without a per-section opt-in", async () => {
    const repo = repoFor("post-prose");
    try {
      await seededPost(repo);
      const projected = await projectPost(repo, "post-1");
      const blocks = projected?.guide.blocks ?? [];
      const sections = blocks.filter((block) => block.type === "section");

      expect(sections).toHaveLength(2);
      expect(sections.map((s) => (s.type === "section" ? s.note.body : ""))).toEqual([
        "Everyone sends you the same three restaurants.",
        "Day two starts west.",
      ]);
      expect(projected?.stats.sections).toBe(2);
      // Prose and embeds keep the author's order.
      expect(blocks.map((block) => block.type)).toEqual(["section", "place", "section"]);
    } finally {
      repo.db.close();
    }
  });

  it("leaves the section note itself private-by-default on the device", async () => {
    const repo = repoFor("post-prose-flag");
    try {
      await seededPost(repo);
      const notes = (await repo.db.notes.toArray()).filter((note) => !note.deleted);

      // `shareable` stays false: it governs place notes, and nothing about a
      // post's own prose should depend on it.
      expect(notes).not.toHaveLength(0);
      expect(notes.every((note) => note.target.kind === "post" && note.shareable === false)).toBe(
        true,
      );
    } finally {
      repo.db.close();
    }
  });
});
