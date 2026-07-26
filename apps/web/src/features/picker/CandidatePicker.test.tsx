/**
 * The review queue's candidate picker (spec/src/interop.md §The review queue):
 * lettered candidates matching the canvas pins, a skip that stays in the
 * report, and dialog focus management.
 */
import type { GeocoderCandidate } from "@placemarks/domain";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CandidatePicker } from "./CandidatePicker";

const candidates: GeocoderCandidate[] = [
  {
    name: "Mercado da Ribeira",
    lat: 38.7071,
    lng: -9.1461,
    address: "Av. 24 de Julho",
    osmRef: { type: "way", id: "1" },
  },
  { name: "Time Out Market", lat: 38.707, lng: -9.1458, osmRef: { type: "node", id: "2" } },
];

describe("import review candidate picker", () => {
  it("letters candidates in stored order and reports the pick", async () => {
    const onPick = vi.fn();
    render(
      <CandidatePicker title="Mercado" candidates={candidates} onPick={onPick} onClose={vi.fn()} />,
    );
    const options = screen.getAllByTestId("candidate-option");
    expect(options[0]?.textContent).toContain("A");
    expect(options[1]?.textContent).toContain("B");
    await userEvent.click(options[1] as HTMLElement);
    expect(onPick).toHaveBeenCalledWith(candidates[1]);
  });

  it("shows distances from the row's own coordinates when it has any", () => {
    render(
      <CandidatePicker
        title="Mercado"
        candidates={candidates}
        origin={{ lat: 38.7071, lng: -9.1461 }}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId("candidate-option")[0]?.textContent).toContain("0 m");
  });

  it("offers skip when wired, and an escape hatch when nothing matched", async () => {
    const onSkip = vi.fn();
    render(
      <CandidatePicker
        title="Nowhere"
        candidates={[]}
        onPick={vi.fn()}
        onSkip={onSkip}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("no-candidates")).toBeVisible();
    await userEvent.click(screen.getByTestId("candidate-skip"));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("manages dialog focus: enters on open, restores on close", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" data-testid="invoker" onClick={() => setOpen(true)}>
            open
          </button>
          {open ? (
            <CandidatePicker
              title="Mercado"
              candidates={candidates}
              onPick={vi.fn()}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </>
      );
    }
    render(<Harness />);
    const invoker = screen.getByTestId("invoker");
    await userEvent.click(invoker);
    // The dialog takes focus on open…
    expect(screen.getByTestId("candidate-picker")).toHaveFocus();
    // …and hands it back to the invoking control on dismissal.
    await userEvent.keyboard("{Escape}");
    expect(invoker).toHaveFocus();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <CandidatePicker
        title="Mercado"
        candidates={candidates}
        onPick={vi.fn()}
        onClose={onClose}
      />,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
