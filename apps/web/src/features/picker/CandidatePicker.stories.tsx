import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import { CandidatePicker } from "./CandidatePicker";

const meta = {
  title: "Picker/CandidatePicker",
  component: CandidatePicker,
  args: {
    onSelect: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof CandidatePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NearbyCandidates: Story = {
  args: { lat: 38.7139, lng: -9.1394 },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByRole("button", { name: /Café Central/ });
    // Distance from the pressed point is shown per candidate.
    await expect(row).toHaveTextContent(/\d+ m/);
    await userEvent.click(row);
    await expect(args.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ osmRef: { type: "node", id: "101" } }),
    );
  },
};

export const NothingMappedHere: Story = {
  args: { lat: 0, lng: 0 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByTestId("no-candidates")).toHaveTextContent(
      "Nothing mapped here yet.",
    );
    // The upstream path is always offered.
    const addLink = canvas.getByRole("link", { name: "Add it on OpenStreetMap" });
    await expect(addLink).toHaveAttribute(
      "href",
      expect.stringContaining("openstreetmap.org/edit"),
    );
  },
};

export const WithManualPinOption: Story = {
  args: { lat: 0, lng: 0, onSaveManual: fn() },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId("no-candidates");
    await userEvent.click(canvas.getByTestId("save-manual"));
    await expect(args.onSaveManual).toHaveBeenCalledWith({ lat: 0, lng: 0 });
  },
};
