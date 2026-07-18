import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import { SearchBar } from "./SearchBar";

const meta = {
  title: "Search/SearchBar",
  component: SearchBar,
  args: { onSelect: fn() },
} satisfies Meta<typeof SearchBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TypeAndSelect: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole("combobox", { name: "Search places" });
    await userEvent.type(input, "cafe");
    // Debounce (250ms) + MSW round-trip; findBy* waits.
    const option = await canvas.findByRole("option", { name: /Café Central/ });
    await userEvent.click(option);
    await expect(args.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { type: "node", id: "101" },
        name: "Café Central",
      }),
    );
  },
};

export const KeyboardNavigation: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole("combobox", { name: "Search places" });
    await userEvent.type(input, "cafe");
    await canvas.findByRole("option", { name: /Café Central/ });
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await expect(args.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ ref: { type: "way", id: "201" }, name: "Café do Rio" }),
    );
  },
};

export const NoResults: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole("combobox", { name: "Search places" }), "zzzz");
    await expect(await canvas.findByText("No places found.")).toBeInTheDocument();
  },
};
