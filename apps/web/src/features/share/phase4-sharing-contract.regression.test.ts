import { markerAt, type PoiResolver, type ResolvedPoi } from "@placemarks/domain";
import type { SharedGuide, SharedPlaceAnchor, SharedPlaceEvidence } from "@placemarks/schemas";
import { render, screen } from "@testing-library/react";
import { deflateSync, strToU8 } from "fflate";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { resolveSharedAnchor } from "./resolveShared";
import { SharedGuideView } from "./SharedGuideView";
import { saveSharedGuide } from "./saveSharedGuide";
import { decodeSnapshot, SNAPSHOT_COMPRESSED_LIMIT } from "./snapshot";

vi.mock("../../map/MapView", () => ({ MapView: () => null }));
const providerMocks = vi.hoisted(() => ({
  resolveExact: vi.fn(),
  searchNearby: vi.fn(),
  discover: vi.fn(),
}));
vi.mock("../../providers", () => ({
  poiResolver: providerMocks,
}));

const NOW = "2026-07-19T12:00:00.000Z";

beforeEach(() => {
  providerMocks.resolveExact.mockReset();
  providerMocks.resolveExact.mockResolvedValue({ type: "error" });
  providerMocks.searchNearby.mockReset();
  providerMocks.searchNearby.mockResolvedValue([]);
  providerMocks.discover.mockReset();
  providerMocks.discover.mockResolvedValue({ pois: [], truncated: false });
});

function evidence(overrides: Partial<SharedPlaceEvidence> = {}): SharedPlaceEvidence {
  return {
    osmRef: { type: "node", id: "101" },
    source: "OpenStreetMap",
    license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    name: "Café Central",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    stableIds: { wikidata: "Q123" },
    observedAt: NOW,
    ...overrides,
  };
}

function poi(overrides: Partial<ResolvedPoi> = {}): ResolvedPoi {
  return {
    osmRef: { type: "node", id: "101" },
    name: "Café Central",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    identityTags: { name: "Café Central", wikidata: "Q123" },
    resolvedAt: NOW,
    ...overrides,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function deterministicNoise(length: number): string {
  const alphabet =
    "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~";
  let state = 0x6d2b79f5;
  let result = "";
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), 1 | state) + index) | 0;
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    result += alphabet[((state ^ (state >>> 14)) >>> 0) % alphabet.length] ?? "x";
  }
  return result;
}

describe("Phase 4 snapshot safety", () => {
  it("enforces the compressed-byte limit while decoding, not only while generating", () => {
    const guide: SharedGuide = {
      v: 1,
      title: "Oversized inbound guide",
      blocks: [
        {
          id: "b1",
          type: "section",
          note: { body: deterministicNoise(65_500) },
        },
      ],
      contentHash: "fixture",
    };
    const compressed = deflateSync(strToU8(JSON.stringify(guide)), { level: 9 });
    const fragment = base64Url(compressed);
    expect(compressed.length).toBeGreaterThan(SNAPSHOT_COMPRESSED_LIMIT);
    expect(fragment.length).toBeLessThan(SNAPSHOT_COMPRESSED_LIMIT * 2);

    expect(() => decodeSnapshot(fragment)).toThrow(/compressed|large|limit|genuine/i);
  });
});

describe("Phase 4 viewer identity", () => {
  it("does not accept a fetched but incompatible current OSM element as the live place", async () => {
    const anchor: SharedPlaceAnchor = {
      kind: "osm",
      currentOsmRef: { type: "node", id: "101" },
      firstSeen: evidence(),
      lastVerified: evidence(),
    };
    const replacement = poi({ osmRef: { type: "way", id: "202" } });
    const resolver: PoiResolver = {
      resolveExact: async () => ({
        type: "ok",
        poi: poi({
          name: "Auto Parts Warehouse",
          category: "car_parts",
          lat: 39.7,
          lng: -8.1,
          identityTags: { name: "Auto Parts Warehouse", shop: "car_parts" },
        }),
      }),
      searchNearby: async () => [replacement],
      discover: async () => ({ pois: [], truncated: false }),
    };

    await expect(resolveSharedAnchor(resolver, anchor)).resolves.toMatchObject({
      state: "recovered",
      poi: { osmRef: { type: "way", id: "202" } },
    });
  });

  it("uses immutable first-seen evidence when the latest observation lost its stable id", async () => {
    const anchor: SharedPlaceAnchor = {
      kind: "osm",
      currentOsmRef: { type: "node", id: "101" },
      firstSeen: evidence(),
      lastVerified: evidence({
        name: "New café name",
        stableIds: undefined,
      }),
    };
    const replacement = poi({ osmRef: { type: "way", id: "202" } });
    const resolver: PoiResolver = {
      resolveExact: async () => ({ type: "gone" }),
      searchNearby: async () => [replacement],
      discover: async () => ({ pois: [], truncated: false }),
    };

    await expect(resolveSharedAnchor(resolver, anchor)).resolves.toMatchObject({
      state: "recovered",
      poi: { osmRef: { type: "way", id: "202" } },
    });
  });

  it("never renders an unsafe copied website as a clickable link", () => {
    const repo = new DexieRepository(`phase4-unsafe-url-${crypto.randomUUID()}`);
    const unsafe = "javascript:alert(document.domain)";
    const copied = evidence({ website: unsafe });
    const guide: SharedGuide = {
      v: 1,
      title: "Untrusted snapshot",
      blocks: [
        {
          id: "b1",
          type: "place",
          place: {
            kind: "osm",
            currentOsmRef: { type: "node", id: "101" },
            firstSeen: copied,
            lastVerified: copied,
          },
        },
      ],
      contentHash: "fixture",
    };
    try {
      render(
        createElement(
          RepoProvider,
          { repo },
          createElement(SharedGuideView, { guide, mode: "snapshot" }),
        ),
      );

      expect(screen.queryByRole("link", { name: unsafe })).not.toBeInTheDocument();
      expect(screen.getByText(unsafe)).toBeInTheDocument();
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 4 manual-anchor import", () => {
  it("imports a shared manual anchor as manual and never auto-matches it to an OSM place", async () => {
    const repo = new DexieRepository(`phase4-manual-anchor-${crypto.randomUUID()}`);
    try {
      await repo.createList({
        id: "existing-list",
        name: "Existing",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.addToList("existing-list", { kind: "poi", poi: poi() }, NOW);
      const guide: SharedGuide = {
        v: 1,
        title: "Imported snapshot",
        blocks: [
          {
            id: "b1",
            type: "place",
            place: {
              kind: "manual",
              name: "Café Central",
              lat: 38.7139,
              lng: -9.1394,
              category: "cafe",
            },
          },
        ],
        contentHash: "fixture",
      };
      const resolver: PoiResolver = {
        resolveExact: async () => ({ type: "error" }),
        searchNearby: async () => [],
        discover: async () => ({ pois: [], truncated: false }),
      };

      await saveSharedGuide(repo, resolver, guide, NOW);

      const places = await repo.listPlaces();
      expect(places).toHaveLength(2);
      expect(places.map(({ place }) => place.origin)).toContain("manual");
      expect(places.find(({ place }) => place.origin === "manual")?.place.resolutionState).toBe(
        "unlinked",
      );
    } finally {
      repo.db.close();
    }
  });
});
