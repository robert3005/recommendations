/**
 * enrichPlace unit tests with a stub geocoder and wikipedia provider: fills
 * only missing fields, one attempt per place per session, and Wikipedia is
 * strictly the fallback behind the element's own tags.
 */
import type { Place } from "@placemarks/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enrichPlace, resetEnrichmentAttempts } from "./enrichment";

const wikipedia = vi.hoisted(() => ({ wikipediaSummary: vi.fn() }));
vi.mock("../../providers/wikipedia", () => wikipedia);

const NOW = "2026-07-26T00:00:00.000Z";
const REF = { type: "node" as const, id: "101" };

function makePlace(extra: Partial<Place> = {}): Place {
  return {
    id: "p1",
    name: "Café Central",
    lat: 38.7139,
    lng: -9.1394,
    origin: "search",
    osmRef: REF,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

function makeRepo() {
  return { updatePlaceFacts: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  resetEnrichmentAttempts();
  wikipedia.wikipediaSummary.mockReset();
});

describe("enrichPlace", () => {
  it("skips places without an osmRef — no lookup at all", async () => {
    const repo = makeRepo();
    const geocoder = { lookup: vi.fn() };
    const { osmRef: _ref, ...pin } = makePlace();
    await enrichPlace(repo, geocoder, pin as Place);
    expect(geocoder.lookup).not.toHaveBeenCalled();
    expect(repo.updatePlaceFacts).not.toHaveBeenCalled();
  });

  it("fills only the missing fields, never overwriting user-visible values", async () => {
    const repo = makeRepo();
    const geocoder = {
      lookup: vi.fn().mockResolvedValue({
        name: "Café Central",
        lat: 38.7139,
        lng: -9.1394,
        osmRef: REF,
        address: "Rua Example 12, Lisboa",
        website: "https://cafecentral.pt",
        phone: "+351 21 000 0000",
        openingHours: "Mo-Fr 08:00-18:00",
        cuisine: "portuguese",
        wheelchair: "limited",
        description: "Historic café.",
      }),
    };
    // The place already carries an address and phone — those must survive.
    const place = makePlace({ address: "My own address", phone: "+351 99 999 9999" });
    await enrichPlace(repo, geocoder, place);

    expect(geocoder.lookup).toHaveBeenCalledExactlyOnceWith(REF);
    expect(repo.updatePlaceFacts).toHaveBeenCalledExactlyOnceWith("p1", {
      website: "https://cafecentral.pt",
      openingHours: "Mo-Fr 08:00-18:00",
      cuisine: "portuguese",
      wheelchair: "limited",
      description: "Historic café.",
      descriptionSource: "osm",
    });
    // Nothing missing and no wikipedia tag: the summary provider is never asked.
    expect(wikipedia.wikipediaSummary).not.toHaveBeenCalled();
  });

  it("attempts each place once per session — repeats are free", async () => {
    const repo = makeRepo();
    const geocoder = { lookup: vi.fn().mockResolvedValue(undefined) };
    const place = makePlace();
    await enrichPlace(repo, geocoder, place);
    await enrichPlace(repo, geocoder, place);
    expect(geocoder.lookup).toHaveBeenCalledTimes(1);

    // A failed attempt still counts as attempted.
    const failing = { lookup: vi.fn().mockRejectedValue(new Error("offline")) };
    const other = makePlace({ id: "p2" });
    await enrichPlace(repo, failing, other);
    await enrichPlace(repo, failing, other);
    expect(failing.lookup).toHaveBeenCalledTimes(1);
    expect(repo.updatePlaceFacts).not.toHaveBeenCalled();
  });

  it("falls back to the Wikipedia summary for description, wikipediaUrl, and photo", async () => {
    const repo = makeRepo();
    const geocoder = {
      lookup: vi.fn().mockResolvedValue({
        name: "Café Central",
        lat: 38.7139,
        lng: -9.1394,
        osmRef: REF,
        wikipedia: "pt:Café Central (Lisboa)",
      }),
    };
    wikipedia.wikipediaSummary.mockResolvedValue({
      extract: "O Café Central é um café histórico.",
      thumbnailUrl: "https://upload.wikimedia.org/wikipedia/commons/a/a1/Central.jpg",
      articleUrl: "https://pt.wikipedia.org/wiki/Caf%C3%A9_Central_(Lisboa)",
    });
    await enrichPlace(repo, geocoder, makePlace());

    expect(wikipedia.wikipediaSummary).toHaveBeenCalledExactlyOnceWith("pt:Café Central (Lisboa)");
    expect(repo.updatePlaceFacts).toHaveBeenCalledExactlyOnceWith("p1", {
      description: "O Café Central é um café histórico.",
      descriptionSource: "wikipedia",
      imageUrl: "https://upload.wikimedia.org/wikipedia/commons/a/a1/Central.jpg",
      wikipediaUrl: "https://pt.wikipedia.org/wiki/Caf%C3%A9_Central_(Lisboa)",
    });
  });

  it("prefers the element's own tags: wikipedia only fills what they left missing", async () => {
    const repo = makeRepo();
    const geocoder = {
      lookup: vi.fn().mockResolvedValue({
        name: "Café Central",
        lat: 38.7139,
        lng: -9.1394,
        osmRef: REF,
        description: "From the OSM tag.",
        wikipedia: "pt:Café Central (Lisboa)",
      }),
    };
    wikipedia.wikipediaSummary.mockResolvedValue({
      extract: "From the article.",
      thumbnailUrl: "https://upload.wikimedia.org/wikipedia/commons/a/a1/Central.jpg",
      articleUrl: "https://pt.wikipedia.org/wiki/Caf%C3%A9_Central_(Lisboa)",
    });
    // The photo is still missing, so the summary is consulted — but the OSM
    // description wins and only the image fallback and article URL land.
    await enrichPlace(repo, geocoder, makePlace());
    expect(repo.updatePlaceFacts).toHaveBeenCalledExactlyOnceWith("p1", {
      description: "From the OSM tag.",
      descriptionSource: "osm",
      imageUrl: "https://upload.wikimedia.org/wikipedia/commons/a/a1/Central.jpg",
      wikipediaUrl: "https://pt.wikipedia.org/wiki/Caf%C3%A9_Central_(Lisboa)",
    });
  });

  it("skips the summary call entirely when description and photo are both settled", async () => {
    const repo = makeRepo();
    const geocoder = {
      lookup: vi.fn().mockResolvedValue({
        name: "Café Central",
        lat: 38.7139,
        lng: -9.1394,
        osmRef: REF,
        wikipedia: "pt:Café Central (Lisboa)",
      }),
    };
    await enrichPlace(
      repo,
      geocoder,
      makePlace({
        description: "Mine.",
        imageUrl: "https://commons.wikimedia.org/wiki/Special:FilePath/C.jpg?width=640",
      }),
    );
    expect(wikipedia.wikipediaSummary).not.toHaveBeenCalled();
    expect(repo.updatePlaceFacts).not.toHaveBeenCalled();
  });

  it("is silent when the summary provider fails after a good lookup", async () => {
    const repo = makeRepo();
    const geocoder = {
      lookup: vi.fn().mockResolvedValue({
        name: "Café Central",
        lat: 38.7139,
        lng: -9.1394,
        osmRef: REF,
        website: "https://cafecentral.pt",
        wikipedia: "pt:Café Central (Lisboa)",
      }),
    };
    wikipedia.wikipediaSummary.mockRejectedValue(new Error("offline"));
    // The whole enrichment is one best-effort pass: a wikipedia failure
    // forfeits the OSM fills too, silently — the next session may retry.
    await expect(enrichPlace(repo, geocoder, makePlace())).resolves.toBeUndefined();
    expect(repo.updatePlaceFacts).not.toHaveBeenCalled();
  });
});
