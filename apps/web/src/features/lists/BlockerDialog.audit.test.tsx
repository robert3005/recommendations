import type { TeardownBlockers } from "@placemarks/domain";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BlockerDialog } from "./BlockerDialog";

const blockers: TeardownBlockers = {
  posts: [{ postId: "post-1", title: "A weekend guide" }],
  members: ["place-1", "place-2"],
  embeds: [
    {
      placeId: "place-1",
      postId: "post-2",
      postTitle: "Coffee tour",
      blockId: "embed-1",
    },
  ],
  notes: [{ placeId: "place-2", noteId: "note-1", title: "Order the custard tart" }],
};

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
});
