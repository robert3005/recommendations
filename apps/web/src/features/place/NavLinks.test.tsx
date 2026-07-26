/**
 * The place card hands out the domain's deep links (spec/src/architecture.md
 * §One module for deep links) — retained URLs win, fallbacks always work, and
 * the OSM link appears exactly when the place carries an osmRef.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NavLinks } from "./NavLinks";

const PLACE = { name: "Café Central", lat: 38.7139, lng: -9.1394 } as const;

describe("place-card deep links", () => {
  it("includes both the place name and coordinates in the Google Maps fallback search", () => {
    render(<NavLinks place={PLACE} />);
    const href = screen.getByTestId("open-google-maps").getAttribute("href");
    const query = new URL(href ?? "").searchParams.get("query");
    expect(query).toContain(PLACE.name);
    expect(query).toContain(`${PLACE.lat},${PLACE.lng}`);
  });

  it("reopens the retained Google listing when one exists", () => {
    const googleUrl = "https://www.google.com/maps/place/Caf%C3%A9+Central/@38.7,-9.1,17z";
    render(<NavLinks place={{ ...PLACE, googleUrl }} />);
    expect(screen.getByTestId("open-google-maps")).toHaveAttribute("href", googleUrl);
  });

  it("always offers an Apple Maps link", () => {
    render(<NavLinks place={PLACE} />);
    expect(screen.getByTestId("open-apple-maps").getAttribute("href")).toContain("maps.apple.com");
  });

  it("links the OSM element page exactly when the place carries an osmRef", () => {
    const { rerender } = render(<NavLinks place={PLACE} />);
    expect(screen.queryByTestId("osm-link")).not.toBeInTheDocument();
    rerender(<NavLinks place={{ ...PLACE, osmRef: { type: "node", id: "123" } }} />);
    expect(screen.getByTestId("osm-link")).toHaveAttribute(
      "href",
      "https://www.openstreetmap.org/node/123",
    );
  });
});
