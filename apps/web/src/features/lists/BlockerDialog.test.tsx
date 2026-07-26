/**
 * Teardown refusals are actionable (spec/src/data-model.md §Teardown): the
 * dialog names every blocker — posts by title with a way in, entry counts,
 * and the live-publication "unpublish first" rule.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Blocker } from "../../data/repo";
import { BlockerDialog } from "./BlockerDialog";

const names = { "post-1": "A weekend guide", "post-2": "Custard tarts, ranked" };

describe("actionable teardown blockers", () => {
  it("names each blocking post and links to it", () => {
    const blockers: Blocker[] = [
      { kind: "list-has-posts", ids: ["post-1"] },
      { kind: "place-has-posts", ids: ["post-2"] },
    ];
    render(
      <BlockerDialog
        title="Can’t delete this list yet"
        blockers={blockers}
        names={names}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("link", { name: /A weekend guide/ })).toHaveAttribute(
      "href",
      "/post/post-1",
    );
    expect(screen.getByRole("link", { name: /Custard tarts, ranked/ })).toHaveAttribute(
      "href",
      "/post/post-2",
    );
  });

  it("counts remaining entries and states the unpublish-first rule", () => {
    const blockers: Blocker[] = [
      { kind: "list-not-empty", ids: ["e1", "e2", "e3"] },
      { kind: "live-publication", ids: ["pub-1"] },
    ];
    render(
      <BlockerDialog title="Can’t delete this list yet" blockers={blockers} onClose={vi.fn()} />,
    );
    expect(screen.getByTestId("blocker-list-not-empty").textContent).toContain("3 places");
    expect(screen.getByTestId("blocker-live-publication").textContent).toContain(
      "unpublish it first",
    );
  });

  it("is a dismissable alertdialog", async () => {
    const onClose = vi.fn();
    render(
      <BlockerDialog
        title="Can’t remove this place yet"
        blockers={[{ kind: "place-has-posts", ids: ["post-1"] }]}
        names={names}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("alertdialog", { name: "Can’t remove this place yet" })).toBeVisible();
    await userEvent.click(screen.getByTestId("blocker-dialog-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
