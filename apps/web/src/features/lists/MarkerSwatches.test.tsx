/**
 * Marker swap stays within free pairs (spec/src/data-model.md §Markers): worn
 * pairs are not offered, the current selection always is.
 */
import { ACCENT_COLORS, MARKER_SHAPES, markerKey } from "@placemarks/domain";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MarkerSwatches } from "./MarkerSwatches";

const orange = ACCENT_COLORS[0]?.fill ?? "#F97316";
const cobalt = ACCENT_COLORS[1]?.fill ?? "#2457E6";

describe("marker swatches", () => {
  it("offers every free pair, keeps the selection, and skips worn pairs", () => {
    render(
      <MarkerSwatches
        radioName="t"
        selected={{ shape: "circle", color: orange }}
        used={[{ shape: "diamond", color: cobalt }]}
        onSelect={vi.fn()}
      />,
    );
    const offered = screen.getAllByRole("radio");
    expect(offered).toHaveLength(ACCENT_COLORS.length * MARKER_SHAPES.length - 1);
    expect(screen.getByTestId(`marker-circle-${orange}`)).toBeChecked();
    expect(screen.queryByTestId(`marker-diamond-${cobalt}`)).not.toBeInTheDocument();
  });

  it("still offers the current selection when another list wears it is impossible — selection wins", () => {
    // A selection that would be filtered as "used" must stay visible.
    render(
      <MarkerSwatches
        radioName="t2"
        selected={{ shape: "circle", color: orange }}
        used={[{ shape: "circle", color: orange }]}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId(`marker-circle-${orange}`)).toBeChecked();
  });

  it("reports the picked pair", async () => {
    const onSelect = vi.fn();
    render(
      <MarkerSwatches
        radioName="t3"
        selected={{ shape: "circle", color: orange }}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByTestId(`marker-star-${cobalt}`));
    expect(onSelect).toHaveBeenCalledWith({ shape: "star", color: cobalt });
    expect(markerKey(onSelect.mock.calls[0]?.[0])).toBe(`star:${cobalt}`);
  });
});
