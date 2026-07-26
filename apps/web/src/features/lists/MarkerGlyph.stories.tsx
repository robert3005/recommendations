/**
 * The marker system's design-QA harness (spec/src/design.md §Markers): all 64
 * shape × accent pairs as solid filled glyphs, plus the numeral-badge variant
 * pairs wear beyond 64 live lists.
 */
import { ACCENT_COLORS, MARKER_SHAPES } from "@placemarks/domain";
import type { Meta, StoryObj } from "@storybook/react";
import { MarkerGlyph } from "./MarkerGlyph";

const meta = {
  title: "Lists/MarkerGlyph",
  component: MarkerGlyph,
} satisfies Meta<typeof MarkerGlyph>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllSixtyFourPairs: Story = {
  args: { marker: { shape: "circle", color: ACCENT_COLORS[0]?.fill ?? "#F97316" } },
  render: () => (
    <div className="flex flex-col gap-2">
      {ACCENT_COLORS.map((accent) => (
        <div key={accent.name} className="flex items-center gap-2">
          {MARKER_SHAPES.map((shape) => (
            <MarkerGlyph key={shape} marker={{ shape, color: accent.fill }} size={24} />
          ))}
          <span className="ml-2 font-mono text-xs">{accent.name}</span>
        </div>
      ))}
    </div>
  ),
};

export const BadgedRepeatVariant: Story = {
  args: {
    marker: { shape: "star", color: ACCENT_COLORS[1]?.fill ?? "#2457E6" },
    size: 28,
    badge: 2,
  },
};
