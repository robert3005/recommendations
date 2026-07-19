/** A shared block keeps its opaque publication identity when guide order changes. */
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { projectGuide } from "./project";

const NOW = "2026-07-19T12:00:00.000Z";
const LATER = "2026-07-19T12:01:00.000Z";

function idsByManualName(
  guide: NonNullable<Awaited<ReturnType<typeof projectGuide>>>["guide"],
): Map<string, string> {
  return new Map(
    guide.blocks.flatMap((block) =>
      block.type === "place" && block.place.kind === "manual"
        ? ([[block.place.name, block.id]] as const)
        : [],
    ),
  );
}

describe("Phase 4 stable publication block ids", () => {
  it("does not renumber existing block identities when their order changes", async () => {
    const repo = new DexieRepository(`phase4-stable-block-${crypto.randomUUID()}`);
    try {
      await repo.createList({
        id: "list-1",
        name: "Stable blocks",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "Alpha", lat: 38.71, lng: -9.14 } },
        NOW,
      );
      await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "Bravo", lat: 38.72, lng: -9.15 } },
        NOW,
      );

      const before = await projectGuide(repo, "list-1");
      if (!before) throw new Error("initial projection missing");
      const beforeIds = idsByManualName(before.guide);
      const localBlocks = await repo.getGuideBlocks("list-1");
      const alpha = localBlocks.find((view) => view.place?.manual?.name === "Alpha")?.block.id;
      const bravo = localBlocks.find((view) => view.place?.manual?.name === "Bravo")?.block.id;
      if (!alpha || !bravo) throw new Error("local block fixture missing");

      // Stability cannot be implemented by leaking the owner's private
      // repository ids into the public document.
      expect([...beforeIds.values()]).not.toContain(alpha);
      expect([...beforeIds.values()]).not.toContain(bravo);

      await repo.moveBlock(bravo, alpha, LATER);
      const after = await projectGuide(repo, "list-1");
      if (!after) throw new Error("updated projection missing");
      const afterIds = idsByManualName(after.guide);

      expect(after.guide.blocks.map((block) => block.id)).not.toEqual(
        before.guide.blocks.map((block) => block.id),
      );
      expect(afterIds.get("Alpha")).toBe(beforeIds.get("Alpha"));
      expect(afterIds.get("Bravo")).toBe(beforeIds.get("Bravo"));
    } finally {
      repo.db.close();
    }
  });
});
