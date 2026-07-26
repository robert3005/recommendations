import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import { NoteEditor } from "./NoteEditor";

const meta = {
  title: "Notes/NoteEditor",
  component: NoteEditor,
  parameters: { layout: "fullscreen" },
  args: {
    note: {
      id: "n1",
      target: { kind: "place", placeId: "p1" },
      body: "",
      shareable: false,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    },
    onSave: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof NoteEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LivePreview: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = canvas.getByLabelText("Note body (Markdown)");
    await userEvent.type(body, "The **espresso** here is superb");
    // The preview pane renders sanitized Markdown as you type.
    const preview = canvas.getByTestId("note-preview");
    await expect(within(preview).getByText("espresso")).toBeInTheDocument();
    await expect(preview.querySelector("strong")).not.toBeNull();
  },
};

export const SaveWithShareableFlag: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText("Note title"), "Espresso notes");
    await userEvent.type(canvas.getByLabelText("Note body (Markdown)"), "Great crema.");
    await userEvent.click(canvas.getByRole("checkbox"));
    await userEvent.click(canvas.getByRole("button", { name: "Save note" }));
    // What persists is the Markdown source.
    await expect(args.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Espresso notes",
        body: "Great crema.",
        shareable: true,
      }),
    );
  },
};

export const CancelDiscards: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await expect(args.onCancel).toHaveBeenCalled();
    await expect(args.onSave).not.toHaveBeenCalled();
  },
};
