/** The ordinary place detail sheet is also a dialog workflow: opening it must
 * move focus inside and closing it must restore the invoking control. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../../state/ui";
import { PlaceSheet } from "./PlaceSheet";

vi.mock("../../providers", () => ({
  poiResolver: {
    resolveExact: vi.fn(async () => ({ type: "error" as const })),
  },
}));

vi.mock("../../data/hooks", () => ({
  useLists: () => [],
  usePlaceForRef: () => undefined,
}));

vi.mock("../../data/RepoContext", () => ({
  useRepo: () => ({}),
}));

function Harness() {
  const selection = useUiStore((state) => state.selection);
  const selectOsm = useUiStore((state) => state.selectOsm);
  useEffect(() => () => useUiStore.setState({ selection: null }), []);
  return (
    <>
      <button
        type="button"
        onClick={() =>
          selectOsm(
            { type: "node", id: "101" },
            { name: "Café Central", lat: 38.7139, lng: -9.1394 },
          )
        }
      >
        Open place details
      </button>
      {selection ? <PlaceSheet /> : null}
    </>
  );
}

afterEach(() => useUiStore.setState({ selection: null }));

describe("Phase 0/1 place-sheet focus management", () => {
  it("moves focus into the sheet and restores it after Close", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      render(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
      );
      const trigger = screen.getByRole("button", { name: "Open place details" });

      await userEvent.click(trigger);
      const dialog = screen.getByRole("dialog", { name: "Café Central" });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);

      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(trigger).toHaveFocus();
    } finally {
      queryClient.clear();
    }
  });
});
