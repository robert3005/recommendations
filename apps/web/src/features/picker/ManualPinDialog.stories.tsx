import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import { ManualPinDialog } from "./ManualPinDialog";

const NOW = "2026-07-18T12:00:00.000Z";

const meta = {
  title: "Picker/ManualPinDialog",
  component: ManualPinDialog,
  parameters: { layout: "fullscreen" },
  args: {
    lat: 38.7139,
    lng: -9.1394,
    lists: [{ id: "l1", name: "Weekend", color: "#2563eb", createdAt: NOW, updatedAt: NOW }],
    onSave: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof ManualPinDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RequiresNameAndList: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const save = canvas.getByTestId("manual-save");
    // A pin can't exist outside a list: name AND list are required.
    await expect(save).toBeDisabled();
    await userEvent.type(canvas.getByTestId("manual-name"), "Our picnic bench");
    await expect(save).toBeDisabled();
    await userEvent.selectOptions(canvas.getByTestId("manual-list-choice"), "l1");
    await expect(save).toBeEnabled();
    await userEvent.click(save);
    await expect(args.onSave).toHaveBeenCalledWith(
      { name: "Our picnic bench", lat: 38.7139, lng: -9.1394 },
      { kind: "existing", listId: "l1" },
    );
  },
};

export const CreatesListInline: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByTestId("manual-name"), "Trailhead");
    await userEvent.selectOptions(canvas.getByTestId("manual-list-choice"), "__new__");
    await userEvent.type(canvas.getByTestId("manual-new-list-name"), "Hikes");
    await userEvent.click(canvas.getByTestId("manual-save"));
    await expect(args.onSave).toHaveBeenCalledWith(
      { name: "Trailhead", lat: 38.7139, lng: -9.1394 },
      // Default marker: the first palette colour not used by existing lists.
      { kind: "new", name: "Hikes", color: "#dc2626" },
    );
  },
};

export const ExplainsUnlinkedness: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(/not linked to OpenStreetMap/),
    ).toBeInTheDocument();
  },
};
