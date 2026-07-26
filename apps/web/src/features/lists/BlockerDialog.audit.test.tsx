import type { Blocker } from "@placemarks/domain";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BlockerDialog } from "./BlockerDialog";

const blockers: Blocker[] = [
  { kind: "post", id: "post-1", label: "A weekend guide", postId: "post-1" },
  { kind: "member", id: "place-1", placeId: "place-1" },
  { kind: "member", id: "place-2", placeId: "place-2" },
  { kind: "embed", id: "embed-1", label: "Coffee tour", postId: "post-2", placeId: "place-1" },
  { kind: "note", id: "note-1", label: "Order the custard tart", placeId: "place-2" },
];

describe("actionable teardown blockers", () => {
  it("names and links every blocker, including each member place", async () => {
    const openPlace = vi.fn();
    render(
      <BlockerDialog
        title="Can’t delete this list yet"
        blockers={blockers}
        placeNames={{ "place-1": "Café Central", "place-2": "Pastelaria Azul" }}
        onOpenPlace={openPlace}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("link", { name: "“A weekend guide”" })).toHaveAttribute(
      "href",
      "/post/post-1/edit",
    );
    expect(within(dialog).getByRole("link", { name: "“Coffee tour”" })).toHaveAttribute(
      "href",
      "/post/post-2/edit#embed-1",
    );
    const memberRows = screen.getAllByTestId("blocker-member");
    expect(memberRows).toHaveLength(2);
    const secondMember = memberRows[1];
    if (!secondMember) throw new Error("second member blocker missing");
    await userEvent.click(within(secondMember).getByRole("button", { name: "Pastelaria Azul" }));
    expect(openPlace).toHaveBeenCalledWith("place-2");
    expect(dialog).toHaveTextContent("Order the custard tart");
  });

  it("offers no bulk note delete unless the caller provides one", () => {
    render(
      <BlockerDialog
        title="Can’t delete this list yet"
        blockers={blockers}
        placeNames={{}}
        onOpenPlace={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("blocker-delete-notes")).not.toBeInTheDocument();
  });

  it("deletes every blocking note in one confirmed action", async () => {
    const onDeleteNotes = vi.fn<(noteIds: string[]) => Promise<void>>(() => Promise.resolve());
    render(
      <BlockerDialog
        title="Can’t remove this place yet"
        blockers={[
          { kind: "note", id: "note-1", label: "First", placeId: "place-1" },
          { kind: "note", id: "note-2", label: "Second", placeId: "place-1" },
          { kind: "embed", id: "embed-1", label: "A post", postId: "post-1" },
        ]}
        placeNames={{ "place-1": "Café Central" }}
        onOpenPlace={vi.fn()}
        onDeleteNotes={onDeleteNotes}
        onClose={vi.fn()}
      />,
    );

    // Naming the count is the point: the owner is told exactly what goes.
    await userEvent.click(screen.getByTestId("blocker-delete-notes"));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete 2 notes permanently?");
    // ...and it only happens after they confirm.
    expect(onDeleteNotes).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("blocker-delete-notes-confirm"));
    // Only the notes — the embed is the author's to remove from the post.
    expect(onDeleteNotes).toHaveBeenCalledWith(["note-1", "note-2"]);
  });

  it("keeps the notes when the owner declines", async () => {
    const onDeleteNotes = vi.fn<(noteIds: string[]) => Promise<void>>(() => Promise.resolve());
    render(
      <BlockerDialog
        title="Can’t remove this place yet"
        blockers={[{ kind: "note", id: "note-1", placeId: "place-1" }]}
        placeNames={{}}
        onOpenPlace={vi.fn()}
        onDeleteNotes={onDeleteNotes}
        onClose={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByTestId("blocker-delete-notes"));
    await userEvent.click(screen.getByRole("button", { name: "Keep them" }));
    expect(onDeleteNotes).not.toHaveBeenCalled();
    expect(screen.getByTestId("blocker-delete-notes")).toBeInTheDocument();
  });
});
