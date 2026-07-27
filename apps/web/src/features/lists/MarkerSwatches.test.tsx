/**
 * The marker picker is shape-first, then colour (spec/src/data-model.md
 * §Markers): a shape row, then that shape in the eight accents; worn pairs
 * are disabled, the current selection always stays choosable.
 */
import { ACCENT_COLORS, MARKER_SHAPES } from "@placemarks/domain";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MarkerSwatches } from "./MarkerSwatches";

const orange = ACCENT_COLORS[0]?.fill ?? "#F97316";
const cobalt = ACCENT_COLORS[1]?.fill ?? "#2457E6";

describe("marker swatches", () => {
  it("offers the shapes first, then the chosen shape's colours, disabling worn pairs", () => {
    render(
      <MarkerSwatches
        radioName="t"
        selected={{ shape: "circle", color: orange }}
        used={[{ shape: "circle", color: cobalt }]}
        onSelect={vi.fn()}
      />,
    );
    // Stage 1: every shape; stage 2: the selected shape's eight colours.
    for (const shape of MARKER_SHAPES) {
      expect(screen.getByTestId(`marker-shape-${shape}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId(`marker-shape-circle`)).toBeChecked();
    expect(screen.getByTestId(`marker-circle-${orange}`)).toBeChecked();
    // The worn pair stays visible but cannot be chosen.
    expect(screen.getByTestId(`marker-circle-${cobalt}`)).toBeDisabled();
  });

  it("keeps the current selection choosable even when listed as used", () => {
    render(
      <MarkerSwatches
        radioName="t2"
        selected={{ shape: "circle", color: orange }}
        used={[{ shape: "circle", color: orange }]}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId(`marker-circle-${orange}`)).toBeChecked();
    expect(screen.getByTestId(`marker-circle-${orange}`)).toBeEnabled();
  });

  it("shape first, then colour — and a free same-colour pair applies on the shape click", async () => {
    const onSelect = vi.fn();
    render(
      <MarkerSwatches
        radioName="t3"
        selected={{ shape: "circle", color: orange }}
        onSelect={onSelect}
      />,
    );
    // Picking a shape keeps the colour when that pair is free.
    await userEvent.click(screen.getByTestId("marker-shape-star"));
    expect(onSelect).toHaveBeenCalledWith({ shape: "star", color: orange });
    // Then a colour pick completes a different pair for that shape.
    await userEvent.click(screen.getByTestId(`marker-star-${cobalt}`));
    expect(onSelect).toHaveBeenLastCalledWith({ shape: "star", color: cobalt });
  });

  it("a shape-click onto a worn same-colour pair waits for the colour row", async () => {
    const onSelect = vi.fn();
    render(
      <MarkerSwatches
        radioName="t4"
        selected={{ shape: "circle", color: orange }}
        used={[{ shape: "star", color: orange }]}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByTestId("marker-shape-star"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByTestId(`marker-star-${orange}`)).toBeDisabled();
    await userEvent.click(screen.getByTestId(`marker-star-${cobalt}`));
    expect(onSelect).toHaveBeenCalledWith({ shape: "star", color: cobalt });
  });
});
