import type { PlacemarksRepository, ResolvedPoi } from "@placemarks/domain";
import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useRepo } from "../../data/RepoContext";
import { PlaceDetailsSheet } from "./PlaceDetailsSheet";

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

/** Seeds the story repo (membership is existence), then renders the sheet. */
function Seeded({ seed }: { seed: (repo: PlacemarksRepository) => Promise<string> }) {
  const repo = useRepo();
  const [placeId, setPlaceId] = useState<string>();
  useEffect(() => {
    void seed(repo).then(setPlaceId);
  }, [repo, seed]);
  if (!placeId) return <div>seeding…</div>;
  return <PlaceDetailsSheet placeId={placeId} />;
}

async function seedListedCafe(repo: PlacemarksRepository): Promise<string> {
  await repo.createList({ id: "l0", name: "Seeds", createdAt: NOW, updatedAt: NOW });
  const view = await repo.addToList("l0", { kind: "poi", poi: cafePoi }, NOW);
  return view.place.id;
}

const meta = {
  title: "Place/PlaceDetailsSheet",
  component: PlaceDetailsSheet,
  parameters: { layout: "fullscreen" },
  // Stories use render() with a seeding harness; the arg is unused but typed-required.
  args: { placeId: "" },
} satisfies Meta<typeof PlaceDetailsSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ListedOsmPlace: Story = {
  render: () => (
    <Seeded
      seed={async (repo) => {
        const placeId = await seedListedCafe(repo);
        await repo.assignTag(placeId, "coffee", NOW);
        return placeId;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId("place-details");
    await expect(await canvas.findByText("Café Central")).toBeInTheDocument();
    await expect(canvas.getByTestId("website-link")).toHaveAttribute(
      "href",
      "https://cafecentral.pt/",
    );
    // Healthy places show no state marker; the OSM affordance is one portal link.
    await expect(canvas.queryByTestId("state-badge")).not.toBeInTheDocument();
    await expect(canvas.getByTestId("osm-link")).toHaveAttribute(
      "href",
      "https://www.openstreetmap.org/node/101",
    );
    await expect(await canvas.findByText("coffee")).toBeInTheDocument();
  },
};

export const TaggingRoundTrip: Story = {
  render: () => <Seeded seed={seedListedCafe} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId("place-details");
    const input = await canvas.findByLabelText("Add tag");
    await userEvent.type(input, "espresso{Enter}");
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
        await repo.createList({ id: "l0", name: "Seeds", createdAt: NOW, updatedAt: NOW });
        const view = await repo.addToList(
          "l0",
          { kind: "manual", facts: { name: "Our picnic bench", lat: 38.72, lng: -9.15 } },
          NOW,
        );
        return view.place.id;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId("place-details");
    await expect(await canvas.findByText("Our picnic bench")).toBeInTheDocument();
    await expect(canvas.getByTestId("state-badge")).toHaveAttribute("data-state", "unlinked");
    await expect(canvas.getByTestId("manual-note")).toBeInTheDocument();
    await expect(canvas.getByTestId("link-to-osm")).toBeInTheDocument();
  },
};

export const AddToAnotherList: Story = {
  render: () => (
    <Seeded
      seed={async (repo) => {
        const placeId = await seedListedCafe(repo);
        await repo.createList({ id: "l1", name: "Weekend", createdAt: NOW, updatedAt: NOW });
        return placeId;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId("place-details");
    const select = await canvas.findByTestId("add-to-list");
    await waitFor(async () => {
      await expect(within(select).getByText("Weekend")).toBeInTheDocument();
    });
    await userEvent.selectOptions(select, "l1");
    await expect(await canvas.findByTestId("sheet-message")).toHaveTextContent(
      'Added to "Weekend"',
    );
    // Once a member, the list leaves the dropdown.
    await waitFor(async () => {
      await expect(within(select).queryByText("Weekend")).not.toBeInTheDocument();
    });
  },
};

export const NoteLifecycle: Story = {
  render: () => <Seeded seed={seedListedCafe} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId("place-details");
    await userEvent.click(await canvas.findByTestId("add-note"));
    const editor = await canvas.findByTestId("note-editor");
    await userEvent.type(
      within(editor).getByLabelText("Note body (Markdown)"),
      "Order the **bica**",
    );
    await userEvent.click(within(editor).getByRole("button", { name: "Save note" }));
    const strong = await canvas.findByText("bica");
    await expect(strong.tagName).toBe("STRONG");
  },
};
