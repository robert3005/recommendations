/**
 * The missing-place OSM handoff must explain contribution safety before opening
 * the public editor, and its modal sheet must manage keyboard focus.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CandidatePicker } from "./CandidatePicker";

vi.mock("../../providers", () => ({
  poiResolver: {
    resolveExact: vi.fn(),
    discover: vi.fn(),
    searchNearby: vi.fn(async () => []),
  },
}));

function Provider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("Phase 1 OpenStreetMap contribution handoff", () => {
  it("warns that edits are public and must use verifiable, non-personal, non-proprietary facts", async () => {
    render(
      <Provider>
        <CandidatePicker lat={51.5} lng={-0.12} onSelect={vi.fn()} onClose={vi.fn()} />
      </Provider>,
    );

    await screen.findByTestId("no-candidates");
    const link = screen.getByRole("link", { name: "Add it on OpenStreetMap" });
    const hasSafetyDisclosure = (text: string) =>
      /public/i.test(text) &&
      /verifiable/i.test(text) &&
      /non-personal|personal (?:data|information|details)/i.test(text) &&
      /check.*existing|existing.*before.*add/i.test(text) &&
      /proprietary|do not copy|don't copy/i.test(text);

    // The disclosure may live in the picker or in a confirmation step opened
    // by the handoff. Prevent only the browser navigation so either UI is testable.
    if (!hasSafetyDisclosure(document.body.textContent ?? "")) {
      link.addEventListener("click", (event) => event.preventDefault(), { once: true });
      await userEvent.click(link);
    }
    await waitFor(() => expect(hasSafetyDisclosure(document.body.textContent ?? "")).toBe(true));
  });

  it("moves focus into the candidate dialog and restores it when Cancel closes the sheet", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <Provider>
          <button type="button" onClick={() => setOpen(true)}>
            Find nearby places
          </button>
          {open ? (
            <CandidatePicker
              lat={51.5}
              lng={-0.12}
              onSelect={vi.fn()}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </Provider>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Find nearby places" });
    await userEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: /Nearby places on OpenStreetMap/i });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(trigger).toHaveFocus();
  });
});
