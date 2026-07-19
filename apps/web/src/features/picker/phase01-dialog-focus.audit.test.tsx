/**
 * Sheet accessibility contract from spec/src/map-view.md: modal workflows
 * manage focus on entry and restore it to the invoking control on dismissal.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ManualPinDialog } from "./ManualPinDialog";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Add manual pin
      </button>
      {open ? (
        <ManualPinDialog
          lat={51.5}
          lng={-0.12}
          lists={[]}
          onSave={vi.fn()}
          onCancel={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

describe("Phase 0 sheet focus management", () => {
  it("moves focus into the manual-pin dialog and restores it on Cancel", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Add manual pin" });

    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: /add unlinked pin/i });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(trigger).toHaveFocus();
  });
});
