import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { StateBadge } from "./StateBadge";

const meta = {
  title: "Place/StateBadge",
  component: StateBadge,
} satisfies Meta<typeof StateBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Resolved: Story = {
  args: { state: "resolved" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Up to date")).toBeInTheDocument();
  },
};

export const Stale: Story = { args: { state: "stale" } };

export const Unavailable: Story = {
  args: { state: "unavailable" },
  play: async ({ canvasElement }) => {
    // Unavailability is not disappearance — the title must say so.
    const badge = within(canvasElement).getByTestId("state-badge");
    await expect(badge).toHaveAttribute("title", expect.stringContaining("not evidence"));
  },
};

export const Missing: Story = { args: { state: "missing" } };

export const NeedsReview: Story = { args: { state: "needs-review" } };

export const Unlinked: Story = {
  args: { state: "unlinked" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Not linked to OSM")).toBeInTheDocument();
  },
};
