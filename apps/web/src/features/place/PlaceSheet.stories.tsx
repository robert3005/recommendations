import type { Decorator, Meta, StoryObj } from "@storybook/react";
import type { OsmElementRef } from "@placemarks/domain";
import { expect, within } from "storybook/test";
import { type SelectionHint, useUiStore } from "../../state/ui";
import { PlaceSheet } from "./PlaceSheet";

/** Seed the UI store with a selection before rendering. */
const withSelection =
  (ref: OsmElementRef, hint?: SelectionHint): Decorator =>
  (Story) => {
    useUiStore.setState({ selection: { kind: "osm", ref, ...(hint ? { hint } : {}) } });
    return <Story />;
  };

const meta = {
  title: "Place/PlaceSheet",
  component: PlaceSheet,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PlaceSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ResolvedFromOsm: Story = {
  decorators: [withSelection({ type: "node", id: "101" })],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link = await canvas.findByTestId("website-link");
    await expect(link).toHaveAttribute("href", "https://cafecentral.pt/");
    await expect(canvas.getByText("Café Central")).toBeInTheDocument();
    // Source actions route corrections upstream to OSM.
    const actions = canvas.getByTestId("osm-actions");
    await expect(within(actions).getByText("View on OpenStreetMap")).toHaveAttribute(
      "href",
      "https://www.openstreetmap.org/node/101",
    );
    await expect(within(actions).getByText("Edit on OpenStreetMap")).toHaveAttribute(
      "href",
      "https://www.openstreetmap.org/edit?node=101",
    );
  },
};

export const NoWebsiteOnOsm: Story = {
  decorators: [withSelection({ type: "node", id: "102" })],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Quiosque Sem Site");
    // No website tag → no link fabricated; the fix path is editing OSM.
    await expect(canvas.queryByTestId("website-link")).not.toBeInTheDocument();
    await expect(canvas.getByText("Edit on OpenStreetMap")).toBeInTheDocument();
  },
};

export const OsmUnreachable: Story = {
  decorators: [
    withSelection({ type: "node", id: "500" }, { name: "Café Central", lat: 38.71, lng: -9.14 }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const error = await canvas.findByTestId("sheet-error");
    // Unavailability is explicitly not disappearance.
    await expect(error).toHaveTextContent("not evidence the place is gone");
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  },
};

export const ElementGone: Story = {
  decorators: [
    withSelection({ type: "node", id: "410" }, { name: "Closed Café", lat: 38.71, lng: -9.14 }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByTestId("sheet-gone")).toHaveTextContent(
      "no longer exists on OpenStreetMap",
    );
  },
};
