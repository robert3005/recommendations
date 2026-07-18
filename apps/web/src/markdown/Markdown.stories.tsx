import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { Markdown } from "./Markdown";

const meta = {
  title: "Notes/Markdown",
  component: Markdown,
} satisfies Meta<typeof Markdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GfmFormatting: Story = {
  args: {
    body: [
      "# Trip notes",
      "",
      "Some **bold** and a list:",
      "",
      "- [x] espresso",
      "- [ ] pastel de nata",
      "",
      "| dish | rating |",
      "| --- | --- |",
      "| bifana | 5/5 |",
    ].join("\n"),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Trip notes" })).toBeInTheDocument();
    await expect(canvas.getByText("bold")).toBeInTheDocument();
    await expect(canvas.getByRole("table")).toBeInTheDocument();
  },
};

export const SanitizedContent: Story = {
  args: {
    body: [
      "Safe text",
      "",
      "<script>window.hacked = true;</script>",
      "",
      '<img src="https://tracker.example/pixel.png">',
      "",
      "![remote](https://tracker.example/pixel.png)",
      "",
      "[evil](javascript:alert(1)) and [fine](https://example.com)",
    ].join("\n"),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Safe text/)).toBeInTheDocument();
    // Raw HTML is disabled: no script executes, no element materializes.
    await expect(canvasElement.querySelector("script")).toBeNull();
    // Remote images are blocked in both HTML and Markdown syntax.
    await expect(canvasElement.querySelector("img")).toBeNull();
    // javascript: links are stripped to plain text; https links are hardened.
    const fine = canvas.getByRole("link", { name: "fine" });
    await expect(fine).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
    const evil = canvas.queryByRole("link", { name: "evil" });
    if (evil) await expect(evil).not.toHaveAttribute("href", expect.stringContaining("javascript"));
  },
};
