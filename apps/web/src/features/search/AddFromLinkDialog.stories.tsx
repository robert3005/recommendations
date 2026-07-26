import { markerAt } from "@placemarks/domain";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import { AddFromLinkDialog } from "./AddFromLinkDialog";

const NOW = "2026-07-18T12:00:00.000Z";

const meta = {
  title: "Search/AddFromLinkDialog",
  component: AddFromLinkDialog,
  parameters: { layout: "fullscreen" },
  args: {
    link: {
      provider: "google-maps",
      url: "https://www.google.com/maps/place/Cervejaria+Ramiro/data=!4m2!3m1!1s0x1f:0x2a",
      coords: { lat: 38.7207, lng: -9.1352 },
      name: "Cervejaria Ramiro",
      fid: "0x1f:0x2a",
    },
    lists: [{ id: "l1", name: "Lisbon", marker: markerAt(0), createdAt: NOW, updatedAt: NOW }],
    onAdd: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof AddFromLinkDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PrefillsTheNameFromTheLink: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("link-name")).toHaveValue("Cervejaria Ramiro");
    // Membership is existence: no list chosen, nothing to add.
    await expect(canvas.getByTestId("link-add")).toBeDisabled();
    await userEvent.selectOptions(canvas.getByTestId("link-list-choice"), "l1");
    await userEvent.click(canvas.getByTestId("link-add"));
    await expect(args.onAdd).toHaveBeenCalledWith("Cervejaria Ramiro", {
      kind: "existing",
      listId: "l1",
    });
  },
};

export const OsmElementArrivesWithItsDetails: Story = {
  args: {
    link: {
      provider: "openstreetmap",
      url: "https://www.openstreetmap.org/node/240109189",
      osmRef: { type: "node", id: "240109189" },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/names an OpenStreetMap node/)).toBeVisible();
    // No name in the URL — the owner supplies one before the place can exist.
    await expect(canvas.getByTestId("link-add")).toBeDisabled();
  },
};

export const ShortLinkAsksForTheFullUrl: Story = {
  args: {
    link: {
      provider: "google-maps",
      url: "https://maps.app.goo.gl/aBcDeFgHiJk",
      needsExpansion: true,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The browser cannot follow the redirect, so the dialog says so rather than
    // guessing a location.
    await expect(canvas.getByText(/shortened share link/)).toBeVisible();
    await expect(canvas.queryByTestId("link-name")).toBeNull();
    await expect(canvas.getByTestId("link-add")).toBeDisabled();
  },
};
