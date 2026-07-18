import type { ManualFacts, PlacemarksRepository, ResolvedPoi } from "@placemarks/domain";
import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useRepo } from "../../data/RepoContext";
import { SavedPlaceSheet } from "./SavedPlaceSheet";

const NOW = "2026-07-18T12:00:00.000Z";

const cafePoi: ResolvedPoi = {
  osmRef: { type: "node", id: "101" },
  name: "Café Central",
  category: "cafe",
  lat: 38.7139,
  lng: -9.1394,
  website: "https://cafecentral.pt/",
  identityTags: { name: "Café Central", amenity: "cafe" },
  resolvedAt: NOW,
};

/** Seeds the story repo, then renders the sheet for the created save. */
function Seeded({ seed }: { seed: (repo: PlacemarksRepository) => Promise<string> }) {
  const repo = useRepo();
  const [savedPlaceId, setSavedPlaceId] = useState<string>();
  useEffect(() => {
    void seed(repo).then(setSavedPlaceId);
  }, [repo, seed]);
  if (!savedPlaceId) return <div>seeding…</div>;
  return <SavedPlaceSheet savedPlaceId={savedPlaceId} />;
}

const meta = {
  title: "Place/SavedPlaceSheet",
  component: SavedPlaceSheet,
  parameters: { layout: "fullscreen" },
  // Stories use render() with a seeding harness; the arg is unused but typed-required.
  args: { savedPlaceId: "" },
} satisfies Meta<typeof SavedPlaceSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SavedOsmPlace: Story = {
  render: () => (
    <Seeded
      seed={async (repo) => {
        const view = await repo.savePoi(cafePoi, NOW);
        await repo.assignTag(view.savedPlace.id, "coffee", NOW);
        return view.savedPlace.id;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId("saved-place-sheet");
    await expect(await canvas.findByText("Café Central")).toBeInTheDocument();
    await expect(canvas.getByTestId("website-link")).toHaveAttribute(
      "href",
      "https://cafecentral.pt/",
    );
    // Saved data is labeled as evidence, never as live.
    await expect(canvas.getByTestId("evidence-note")).toBeInTheDocument();
    await expect(await canvas.findByText("coffee")).toBeInTheDocument();
  },
};

export const TaggingRoundTrip: Story = {
  render: () => <Seeded seed={async (repo) => (await repo.savePoi(cafePoi, NOW)).savedPlace.id} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId("saved-place-sheet");
    const input = await canvas.findByLabelText("Add tag");
    await userEvent.type(input, "espresso{Enter}");
    // liveQuery propagates the repository write back into the chip list.
    await expect(await canvas.findByText("espresso")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Remove tag espresso" }));
    await waitFor(async () => {
      await expect(
        canvas.queryByRole("button", { name: "Remove tag espresso" }),
      ).not.toBeInTheDocument();
    });
  },
};

export const ManualUnlinkedPin: Story = {
  render: () => (
    <Seeded
      seed={async (repo) => {
        const facts: ManualFacts = { name: "Our picnic bench", lat: 38.72, lng: -9.15 };
        return (await repo.saveManual(facts, NOW)).savedPlace.id;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId("saved-place-sheet");
    await expect(await canvas.findByText("Our picnic bench")).toBeInTheDocument();
    await expect(canvas.getByTestId("state-badge")).toHaveAttribute("data-state", "unlinked");
    await expect(canvas.getByTestId("manual-note")).toBeInTheDocument();
    // The upgrade path is offered.
    await expect(canvas.getByTestId("link-to-osm")).toBeInTheDocument();
  },
};

export const NoteLifecycle: Story = {
  render: () => <Seeded seed={async (repo) => (await repo.savePoi(cafePoi, NOW)).savedPlace.id} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId("saved-place-sheet");
    await userEvent.click(await canvas.findByTestId("add-note"));
    const editor = await canvas.findByTestId("note-editor");
    await userEvent.type(
      within(editor).getByLabelText("Note body (Markdown)"),
      "Order the **bica**",
    );
    await userEvent.click(within(editor).getByRole("button", { name: "Save note" }));
    // The saved note renders through the sanitized Markdown pipeline.
    const strong = await canvas.findByText("bica");
    await expect(strong.tagName).toBe("STRONG");
  },
};
