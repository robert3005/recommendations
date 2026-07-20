/** A place-note preflight must disclose the complete public anchor and image transformation. */
import { markerAt, type Note, type ResolvedPoi } from "@placemarks/domain";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { NotePublishButton } from "./NotePublishButton";

const NOW = "2026-07-19T10:00:00.000Z";

const POI: ResolvedPoi = {
  osmRef: { type: "node", id: "991122" },
  osmVersion: 17,
  name: "Full-anchor café",
  category: "cafe",
  lat: 38.713912,
  lng: -9.139456,
  address: "Rua Disclosure 12, Lisboa",
  website: "https://full-anchor.example/",
  phone: "+351 210 000 111",
  identityTags: { name: "Full-anchor café", wikidata: "Q-PREFLIGHT-123" },
  resolvedAt: "2024-05-06T07:08:09.000Z",
};

describe("Phase 5 place-note preflight completeness", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows every copied anchor field and the public image placeholder before sending", async () => {
    const repo = new DexieRepository(`phase5-place-note-preflight-${crypto.randomUUID()}`);
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ slug: "full-anchor-note", revision: 1 }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetcher);

    try {
      await repo.createList({
        id: "list-1",
        name: "Lisbon",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const place = (await repo.addToList("list-1", { kind: "poi", poi: POI }, NOW)).place;
      const note: Note = {
        id: "note-1",
        target: { kind: "place", placeId: place.id },
        title: "Field note",
        body: "Before ![Private terrace](asset:private-media) after",
        mediaIds: ["private-media"],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);

      render(
        <RepoProvider repo={repo}>
          <NotePublishButton note={note} />
        </RepoProvider>,
      );
      await userEvent.click(screen.getByRole("button", { name: "Publish page" }));

      const preflight = await screen.findByTestId("note-publish-preflight");
      await waitFor(() => expect(preflight).toHaveTextContent(POI.name ?? ""));
      const disclosure = preflight.textContent ?? "";

      for (const publicValue of [
        POI.osmRef.type,
        POI.osmRef.id,
        POI.osmVersion?.toString() ?? "",
        POI.lat.toString(),
        POI.lng.toString(),
        POI.address ?? "",
        POI.website ?? "",
        POI.phone ?? "",
        "wikidata",
        POI.identityTags.wikidata ?? "",
        POI.resolvedAt,
        "OpenStreetMap",
        "ODbL-1.0",
      ]) {
        expect
          .soft(disclosure, `missing copied public value: ${publicValue}`)
          .toContain(publicValue);
      }
      expect.soft(disclosure).toContain("Private terrace");
      expect.soft(disclosure).toMatch(/image omitted from (?:the )?shared page/i);
      expect(disclosure).not.toContain("asset:private-media");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      repo.db.close();
    }
  });
});
