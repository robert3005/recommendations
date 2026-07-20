/**
 * Every advertised KML export is My Maps-compatible. The direct KML button
 * must apply the same 5 MB guard as the guided handoff; one oversized feature
 * is refused because it cannot be split safely.
 */
import { type List, type ListBlockView, markerAt, type Note, type Place } from "@placemarks/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportListKml } from "../interop/export";
import { ListPage } from "./ListPage";

const NOW = "2026-07-19T12:00:00.000Z";
const MY_MAPS_FILE_LIMIT = 5 * 1024 * 1024;
const list: List = {
  id: "direct-kml-oversized",
  name: "Direct KML limit",
  marker: markerAt(0),
  createdAt: NOW,
  updatedAt: NOW,
};
const place: Place = {
  id: "direct-kml-place",
  origin: "manual",
  osmRefHistory: [],
  manual: { name: "One large place", lat: 38.7, lng: -9.1 },
  resolutionState: "unlinked",
  createdAt: NOW,
  updatedAt: NOW,
};
const blocks: ListBlockView[] = [
  {
    block: {
      id: "direct-kml-block",
      listId: list.id,
      rank: "a",
      content: { type: "place", placeId: place.id },
      createdAt: NOW,
      updatedAt: NOW,
    },
    place,
  },
];

const mocks = vi.hoisted(() => ({
  downloadText: vi.fn(),
  listNotesForPlace: vi.fn<(placeId: string) => Promise<Note[]>>(),
}));

function setBlockCount(count: number): Place[] {
  const places = Array.from(
    { length: count },
    (_, index): Place => ({
      ...place,
      id: `direct-kml-place-${index.toString()}`,
      manual: {
        name: `Place ${index.toString()}`,
        lat: 38.7 + index / 1_000_000,
        lng: -9.1,
      },
    }),
  );
  blocks.splice(
    0,
    blocks.length,
    ...places.map(
      (itemPlace, index): ListBlockView => ({
        block: {
          id: `direct-kml-block-${index.toString()}`,
          listId: list.id,
          rank: index.toString().padStart(5, "0"),
          content: { type: "place", placeId: itemPlace.id },
          createdAt: NOW,
          updatedAt: NOW,
        },
        place: itemPlace,
      }),
    ),
  );
  return places;
}

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ listId: list.id }),
}));

vi.mock("../../data/hooks", () => ({
  useList: () => list,
  useListBlocks: () => blocks,
  usePostsForList: () => [],
  useLists: () => [list],
}));

vi.mock("../../data/RepoContext", () => ({
  useRepo: () => ({
    getPlaceView: vi.fn(async () => ({ tags: [] })),
    listNotesForPlace: mocks.listNotesForPlace,
    moveBlock: vi.fn(),
    removeBlock: vi.fn(),
    updateList: vi.fn(),
  }),
}));

vi.mock("../../lib/download", () => ({
  downloadText: mocks.downloadText,
  downloadBytes: vi.fn(),
}));

vi.mock("../publish/PublishControls", () => ({ PublishControls: () => null }));

describe("Phase 3 direct KML My Maps limits", () => {
  beforeEach(() => {
    blocks.splice(0, blocks.length, {
      block: {
        id: "direct-kml-block",
        listId: list.id,
        rank: "a",
        content: { type: "place", placeId: place.id },
        createdAt: NOW,
        updatedAt: NOW,
      },
      place,
    });
    mocks.downloadText.mockClear();
    mocks.listNotesForPlace.mockReset().mockResolvedValue([
      {
        id: "direct-kml-note",
        target: { kind: "place", placeId: place.id },
        body: "x".repeat(MY_MAPS_FILE_LIMIT + 4096),
        mediaIds: [],
        shareable: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
  });

  it("never emits an oversized file from the direct KML export button", async () => {
    render(<ListPage />);
    fireEvent.click(screen.getByTestId("export-kml"));

    await waitFor(() => {
      const refused = screen.queryByText(/Export failed/i) !== null;
      expect(refused || mocks.downloadText.mock.calls.length > 0).toBe(true);
    });
    const outputs = mocks.downloadText.mock.calls.map((call) => call[2] as string);
    expect(
      outputs.every((output) => new TextEncoder().encode(output).byteLength <= MY_MAPS_FILE_LIMIT),
    ).toBe(true);
    const error = screen.getByText(/Export failed/i);
    expect(error).toHaveTextContent(/5 MB/i);
    expect(error).not.toHaveTextContent(/notes could not be read/i);
  });

  it("splits direct KML export before a layer exceeds 2,000 features", async () => {
    mocks.listNotesForPlace.mockReset().mockResolvedValue([]);
    setBlockCount(2001);

    render(<ListPage />);
    fireEvent.click(screen.getByTestId("export-kml"));

    await waitFor(() => expect(mocks.downloadText).toHaveBeenCalled());
    const outputs = mocks.downloadText.mock.calls.map((call) => call[2] as string);
    expect(outputs.length).toBeGreaterThan(1);
    expect(outputs.every((output) => (output.match(/<Placemark>/g) ?? []).length <= 2000)).toBe(
      true,
    );
  });

  it("measures multipart KML after adding its final part name", async () => {
    const places = setBlockCount(2001);
    const emptyViews = places.slice(0, 2000).map((itemPlace) => ({
      place: itemPlace,
      notes: [] as Note[],
    }));
    const probe: Note = {
      id: "direct-kml-boundary-note",
      target: { kind: "place", placeId: places[0]?.id ?? place.id },
      body: "x",
      mediaIds: [],
      shareable: false,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const oneCharacterViews = emptyViews.map((view, index) =>
      index === 0 ? { ...view, notes: [probe] } : view,
    );
    const encoder = new TextEncoder();
    const baseBytes = encoder.encode(exportListKml(list, emptyViews)).byteLength;
    const noteWrapperBytes =
      encoder.encode(exportListKml(list, oneCharacterViews)).byteLength - baseBytes - 1;
    const bodyLength = MY_MAPS_FILE_LIMIT - baseBytes - noteWrapperBytes;
    expect(bodyLength).toBeGreaterThan(0);
    const boundaryNote = { ...probe, body: "x".repeat(bodyLength) };
    mocks.listNotesForPlace
      .mockReset()
      .mockImplementation(async (placeId) => (placeId === places[0]?.id ? [boundaryNote] : []));

    render(<ListPage />);
    fireEvent.click(screen.getByTestId("export-kml"));

    await waitFor(() => expect(mocks.downloadText).toHaveBeenCalled());
    const outputs = mocks.downloadText.mock.calls.map((call) => call[2] as string);
    expect(outputs.length).toBeGreaterThan(1);
    expect(outputs.every((output) => encoder.encode(output).byteLength <= MY_MAPS_FILE_LIMIT)).toBe(
      true,
    );
  });
});
