import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { PlaceFields } from "./PlaceFields";

const meta = {
  title: "Place/PlaceFields",
  component: PlaceFields,
} satisfies Meta<typeof PlaceFields>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LiveWithWebsite: Story = {
  args: {
    name: "Café Central",
    category: "cafe",
    address: "Rua Example 12, 1100-000 Lisboa",
    website: "https://cafecentral.pt/",
    phone: "+351 21 000 0000",
    openingHours: "Mo-Fr 08:00-18:00; Sa 09:00-14:00",
    source: "live",
    // Friday 10:00 UTC — inside opening hours, deterministic for tests.
    now: new Date("2026-07-17T10:00:00Z"),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link = canvas.getByTestId("website-link");
    // The website is the prize (book/src/vision.md) — and it must be safe.
    await expect(link).toHaveAttribute("href", "https://cafecentral.pt/");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(canvas.getByText("Open now")).toBeInTheDocument();
  },
};

export const ClosedNow: Story = {
  args: {
    ...LiveWithWebsite.args,
    now: new Date("2026-07-19T10:00:00Z"), // Sunday — closed
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Closed")).toBeInTheDocument();
  },
};

export const EvidenceFallback: Story = {
  args: {
    name: "Café Central",
    category: "cafe",
    website: "https://cafecentral.pt/",
    source: "osm-evidence",
    observedAt: "2026-06-01T00:00:00.000Z",
    state: "unavailable",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Copied evidence is labeled with its observation time, never shown as live.
    await expect(canvas.getByTestId("evidence-note")).toHaveTextContent("Showing saved OSM data");
    await expect(canvas.getByTestId("state-badge")).toHaveTextContent("OSM unreachable");
  },
};

export const ManualPin: Story = {
  args: {
    name: "Our picnic bench",
    category: "picnic spot",
    source: "manual",
    state: "unlinked",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("manual-note")).toHaveTextContent(
      "not linked to OpenStreetMap",
    );
    await expect(canvas.getByTestId("state-badge")).toHaveTextContent("Not linked to OSM");
  },
};

export const Minimal: Story = {
  args: { source: "live" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Unnamed place")).toBeInTheDocument();
  },
};
