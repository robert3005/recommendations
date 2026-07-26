/**
 * The Markdown pipeline (spec/src/posts.md §The body): same parser and
 * sanitizer everywhere; raw HTML disabled; no images; local mode allows
 * place:/post: links, viewer mode only http/https and # fragments; soft links
 * degrade to plain text.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown pipeline", () => {
  it("renders CommonMark + GFM: headings, tables, labelled task lists", () => {
    const body = [
      "# Trip notes",
      "",
      "Some **bold** text.",
      "",
      "- [x] espresso",
      "- [ ] pastel de nata",
      "",
      "| dish | rating |",
      "| --- | --- |",
      "| bifana | 5/5 |",
    ].join("\n");
    render(<Markdown body={body} />);

    expect(screen.getByRole("heading", { name: "Trip notes" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "completed task" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "open task" })).not.toBeChecked();
  });

  it("disables raw HTML and strips javascript: links to plain text", () => {
    const body = [
      "Safe text",
      "",
      "<script>window.hacked = true;</script>",
      "",
      "[evil](javascript:alert(1)) and [fine](https://example.com)",
    ].join("\n");
    const { container } = render(<Markdown body={body} />);

    expect(screen.getByText(/Safe text/)).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.queryByRole("link", { name: "evil" })).toBeNull();
    expect(screen.getByText("evil")).toBeInTheDocument();
  });

  it("hardens external links with rel and target", () => {
    render(<Markdown body="[fine](https://example.com)" />);
    const link = screen.getByRole("link", { name: "fine" });
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("drops images entirely — markdown, raw HTML, and legacy asset: ids", () => {
    const body = [
      "![remote](https://tracker.example/pixel.png)",
      "",
      '<img src="https://tracker.example/pixel.png">',
      "",
      "![old](asset:media-1)",
    ].join("\n");
    const { container } = render(<Markdown body={body} />);
    expect(container.querySelector("img")).toBeNull();
  });

  describe("local mode", () => {
    it("renders projected mentions as interactive links and fires onPlaceClick", async () => {
      const onPlaceClick = vi.fn();
      render(
        <Markdown
          body="Start at [Café Central](place:place-a)."
          placeIds={new Set(["place-a"])}
          onPlaceClick={onPlaceClick}
        />,
      );
      const mention = screen.getByRole("button", { name: "Café Central" });
      expect(mention).toHaveAttribute("data-mention-place", "place-a");
      await userEvent.click(mention);
      expect(onPlaceClick).toHaveBeenCalledWith("place-a");
    });

    it("marks the selected mention for pin↔mention sync", () => {
      render(
        <Markdown
          body="[Café Central](place:place-a)"
          placeIds={new Set(["place-a"])}
          selectedPlaceId="place-a"
        />,
      );
      expect(screen.getByRole("button", { name: "Café Central" })).toHaveAttribute(
        "aria-current",
        "true",
      );
    });

    it("renders a mention outside the projection as plain text", () => {
      render(<Markdown body="[Elsewhere](place:place-z)" placeIds={new Set(["place-a"])} />);
      expect(screen.queryByRole("button", { name: "Elsewhere" })).toBeNull();
      expect(screen.getByText("Elsewhere")).toBeInTheDocument();
    });

    it("renders cross-post links that resolve and unwraps dangling ones", async () => {
      const onPostClick = vi.fn();
      render(
        <Markdown
          body="See [the guide](post:post-2) and [gone](post:post-9)."
          postIds={new Set(["post-2"])}
          onPostClick={onPostClick}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "the guide" }));
      expect(onPostClick).toHaveBeenCalledWith("post-2");
      expect(screen.queryByRole("button", { name: "gone" })).toBeNull();
      expect(screen.getByText("gone")).toBeInTheDocument();
    });

    it("does not allow fragment links locally", () => {
      render(<Markdown body="[jump](#somewhere)" />);
      expect(screen.queryByRole("link", { name: "jump" })).toBeNull();
      expect(screen.getByText("jump")).toBeInTheDocument();
    });
  });

  describe("viewer mode", () => {
    it("never renders place:/post: protocols, even when ids resolve", () => {
      render(
        <Markdown
          mode="viewer"
          body="[Café](place:place-a) and [guide](post:post-2)"
          placeIds={new Set(["place-a"])}
          postIds={new Set(["post-2"])}
        />,
      );
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.getByText("Café")).toBeInTheDocument();
      expect(screen.getByText("guide")).toBeInTheDocument();
    });

    it("allows # fragments and hands them to onFragmentClick", async () => {
      const onFragmentClick = vi.fn();
      render(
        <Markdown
          mode="viewer"
          body="[Café Central](#place-place-a)"
          onFragmentClick={onFragmentClick}
        />,
      );
      const link = screen.getByRole("link", { name: "Café Central" });
      expect(link).toHaveAttribute("href", "#place-place-a");
      await userEvent.click(link);
      expect(onFragmentClick).toHaveBeenCalledWith("#place-place-a");
    });

    it("keeps http/https links and drops everything else", () => {
      render(
        <Markdown mode="viewer" body="[fine](https://example.com) [evil](javascript:alert(1))" />,
      );
      expect(screen.getByRole("link", { name: "fine" })).toHaveAttribute(
        "rel",
        "noopener noreferrer nofollow",
      );
      expect(screen.queryByRole("link", { name: "evil" })).toBeNull();
    });
  });
});
