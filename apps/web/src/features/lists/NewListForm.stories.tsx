import { markerAt } from "@placemarks/domain";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import { NewListForm } from "./NewListForm";

const meta = {
  title: "Lists/NewListForm",
  component: NewListForm,
  args: {
    lists: [],
    submitLabel: "Create list",
    submitTestId: "create-list",
    radioName: "story-marker",
    onCreate: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof NewListForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CreatesWithSuggestedMarker: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const submit = canvas.getByTestId("create-list");
    await expect(submit).toBeDisabled();
    await userEvent.type(canvas.getByLabelText("New list name"), "Weekend");
    // First list → the first (colour, icon) combination is preselected.
    await expect(canvas.getByTestId("marker-#dc2626-circle")).toBeChecked();
    await userEvent.click(submit);
    await expect(args.onCreate).toHaveBeenCalledWith("Weekend", {
      color: "#dc2626",
      icon: "circle",
    });
  },
};

export const PickedMarkerWins: Story = {
  args: {
    lists: [
      {
        id: "l1",
        name: "Taken red circle",
        marker: markerAt(0),
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
    ],
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    // Red circle is taken → the next unused combination is suggested; the
    // user overrides with the teal heart.
    await expect(canvas.getByTestId("marker-#2563eb-diamond")).toBeChecked();
    await userEvent.click(canvas.getByTestId("marker-#0d9488-heart"));
    await userEvent.type(canvas.getByLabelText("New list name"), "Hikes");
    await userEvent.click(canvas.getByTestId("create-list"));
    await expect(args.onCreate).toHaveBeenCalledWith("Hikes", {
      color: "#0d9488",
      icon: "heart",
    });
  },
};

export const EscapeCancels: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText("New list name"), "{Escape}");
    await expect(args.onCancel).toHaveBeenCalled();
    await expect(args.onCreate).not.toHaveBeenCalled();
  },
};
