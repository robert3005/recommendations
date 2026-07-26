import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import { NewListForm } from "./NewListForm";

const meta = {
  title: "Lists/NewListForm",
  component: NewListForm,
  args: {
    submitLabel: "Create list",
    submitTestId: "create-list",
    onCreate: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof NewListForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CreatesByName: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const submit = canvas.getByTestId("create-list");
    await expect(submit).toBeDisabled();
    await userEvent.type(canvas.getByLabelText("New list name"), "Weekend");
    await userEvent.click(submit);
    // The repository assigns the marker — the form only names the list
    // (spec/src/data-model.md §Markers).
    await expect(args.onCreate).toHaveBeenCalledWith("Weekend");
  },
};
