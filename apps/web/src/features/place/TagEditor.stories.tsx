import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import { TagEditor } from "./TagEditor";

const meta = {
  title: "Place/TagEditor",
  component: TagEditor,
  args: {
    tags: [
      {
        id: "t1",
        name: "coffee",
        nameNorm: "coffee",
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
    ],
    onAdd: fn(),
    onRemove: fn(),
  },
} satisfies Meta<typeof TagEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AddByKeyboard: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText("Add tag");
    await userEvent.type(input, "date-night{Enter}");
    await expect(args.onAdd).toHaveBeenCalledWith("date-night");
    await expect(input).toHaveValue("");
  },
};

export const RemoveChip: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Remove tag coffee" }));
    await expect(args.onRemove).toHaveBeenCalledWith("t1");
  },
};
