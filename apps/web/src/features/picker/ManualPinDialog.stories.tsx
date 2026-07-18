import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import { ManualPinDialog } from "./ManualPinDialog";

const meta = {
  title: "Picker/ManualPinDialog",
  component: ManualPinDialog,
  parameters: { layout: "fullscreen" },
  args: { lat: 38.7139, lng: -9.1394, onSave: fn(), onCancel: fn() },
} satisfies Meta<typeof ManualPinDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RequiresName: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const save = canvas.getByTestId("manual-save");
    await expect(save).toBeDisabled();
    await userEvent.type(canvas.getByTestId("manual-name"), "Our picnic bench");
    await expect(save).toBeEnabled();
    await userEvent.click(save);
    await expect(args.onSave).toHaveBeenCalledWith({
      name: "Our picnic bench",
      lat: 38.7139,
      lng: -9.1394,
    });
  },
};

export const ExplainsUnlinkedness: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(/not linked to OpenStreetMap/),
    ).toBeInTheDocument();
  },
};
