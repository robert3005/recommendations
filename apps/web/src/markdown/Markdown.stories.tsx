import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { Markdown } from "./Markdown";

const meta = {
  title: "Posts/Markdown",
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
    // Images are out of the format entirely (spec/src/posts.md §The body).
    await expect(canvasElement.querySelector("img")).toBeNull();
    // javascript: links are stripped to plain text; https links are hardened.
    const fine = canvas.getByRole("link", { name: "fine" });
    await expect(fine).toHaveAttribute("rel", "noopener noreferrer nofollow");
    await expect(canvas.queryByRole("link", { name: "evil" })).toBeNull();
  },
};

export const MentionsAndCrossPostLinks: Story = {
  args: {
    body: [
      "Start at [Café Central](place:place-a), detour past [Elsewhere](place:place-z),",
      "then read [the full guide](post:post-2).",
    ].join("\n"),
    placeIds: new Set(["place-a"]),
    postIds: new Set(["post-2"]),
    selectedPlaceId: "place-a",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // A projected mention is interactive and carries the selection highlight.
    const mention = canvas.getByRole("button", { name: "Café Central" });
    await expect(mention).toHaveAttribute("aria-current", "true");
    // Soft links: an out-of-projection mention reads as prose.
    await expect(canvas.queryByRole("button", { name: "Elsewhere" })).toBeNull();
    await expect(canvas.getByText("Elsewhere")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "the full guide" })).toBeInTheDocument();
  },
};

export const ViewerMode: Story = {
  args: {
    mode: "viewer",
    body: "[Café Central](#place-place-a) — never [a protocol](place:place-a).",
    placeIds: new Set(["place-a"]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The viewer maps fragments to pin focus; custom protocols degrade to text.
    await expect(canvas.getByRole("link", { name: "Café Central" })).toHaveAttribute(
      "href",
      "#place-place-a",
    );
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvas.getByText("a protocol")).toBeInTheDocument();
  },
};
