/**
 * The list page's Export menu (spec/src/map-view.md §The list page): one
 * accessible menu button in front of every artefact download and the guided
 * handoffs — arrow keys move the roving focus, Escape and outside click
 * close, activation runs the item and hands focus back to the button.
 * Plus the quiet Places/Posts view toggle (2026-07-26 — search-first
 * chrome): pressed-state buttons, keyboard operable.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ExportMenu, type ExportMenuItem, type ListView, ListViewToggle } from "./ListPage";

function items(run = vi.fn()): {
  artefacts: ExportMenuItem[];
  handoffs: ExportMenuItem[];
  run: ReturnType<typeof vi.fn>;
} {
  return {
    run,
    artefacts: [
      { testid: "export-md", label: "Text list", run },
      { testid: "export-kml", label: "KML", run },
    ],
    handoffs: [{ testid: "handoff-my-maps", label: "Google My Maps", run }],
  };
}

describe("ExportMenu", () => {
  it("opens on click, activates an item, and closes back to the button", async () => {
    const { artefacts, handoffs, run } = items();
    render(<ExportMenu artefacts={artefacts} handoffs={handoffs} />);

    const button = screen.getByTestId("export-menu");
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    // The handoffs are a labelled group inside the menu.
    expect(screen.getByRole("group", { name: "Guided handoffs" })).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("export-kml"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("moves the roving focus with arrow keys and wraps", async () => {
    const { artefacts, handoffs } = items();
    render(<ExportMenu artefacts={artefacts} handoffs={handoffs} />);

    // ArrowDown on the closed button opens with the first item focused.
    screen.getByTestId("export-menu").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByTestId("export-md")).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByTestId("export-kml")).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByTestId("handoff-my-maps")).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}"); // wraps
    expect(screen.getByTestId("export-md")).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}"); // wraps back
    expect(screen.getByTestId("handoff-my-maps")).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByTestId("handoff-my-maps")).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByTestId("export-md")).toHaveFocus();
  });

  it("closes on Escape (refocusing the button) and on outside click", async () => {
    const { artefacts, handoffs, run } = items();
    render(
      <div>
        <ExportMenu artefacts={artefacts} handoffs={handoffs} />
        <button type="button" data-testid="elsewhere">
          elsewhere
        </button>
      </div>,
    );
    const button = screen.getByTestId("export-menu");

    await userEvent.click(button);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(button).toHaveFocus();

    await userEvent.click(button);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("elsewhere"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("ListViewToggle", () => {
  function Harness() {
    const [view, setView] = useState<ListView>("places");
    return <ListViewToggle view={view} onChange={setView} />;
  }

  it("defaults to Places and flips the pressed state on click", async () => {
    render(<Harness />);
    const places = screen.getByTestId("list-view-places");
    const posts = screen.getByTestId("list-view-posts");
    expect(screen.getByTestId("list-view-toggle")).toBeInTheDocument();
    expect(places).toHaveAttribute("aria-pressed", "true");
    expect(posts).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(posts);
    expect(posts).toHaveAttribute("aria-pressed", "true");
    expect(places).toHaveAttribute("aria-pressed", "false");
  });

  it("is keyboard operable: focus and Enter switch views", async () => {
    render(<Harness />);
    const posts = screen.getByTestId("list-view-posts");
    posts.focus();
    await userEvent.keyboard("{Enter}");
    expect(posts).toHaveAttribute("aria-pressed", "true");

    const places = screen.getByTestId("list-view-places");
    places.focus();
    await userEvent.keyboard(" ");
    expect(places).toHaveAttribute("aria-pressed", "true");
    expect(posts).toHaveAttribute("aria-pressed", "false");
  });
});
