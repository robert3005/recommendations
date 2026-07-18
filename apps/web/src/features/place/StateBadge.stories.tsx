import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { StateBadge } from "./StateBadge";

const meta = {
  title: "Place/StateBadge",
  component: StateBadge,
} satisfies Meta<typeof StateBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unlinked: Story = {
  args: { state: "unlinked" },
  play: async ({ canvasElement }) => {
    const badge = within(canvasElement).getByTestId("state-badge");
    await expect(badge).toHaveTextContent("Not linked to OSM");
    await expect(badge).toHaveAttribute("data-state", "unlinked");
  },
};

export const HealthyStatesRenderNothing: Story = {
  args: { state: "resolved" },
  play: async ({ canvasElement }) => {
    // Freshness/recovery badges are deferred; only unlinked manual pins are marked.
    await expect(within(canvasElement).queryByTestId("state-badge")).not.toBeInTheDocument();
  },
};
