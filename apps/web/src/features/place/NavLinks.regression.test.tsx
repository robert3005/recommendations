import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NavLinks } from "./NavLinks";

const PLACE = { lat: 38.7139, lng: -9.1394, name: "Café Central" } as const;

describe("navigation link regressions", () => {
  it("includes both the place name and coordinates in the Google Maps fallback search", () => {
    render(<NavLinks {...PLACE} />);

    const href = screen.getByTestId("open-google-maps").getAttribute("href");
    expect(href).toBeTruthy();
    const query = new URL(href ?? "").searchParams.get("query");
    expect(query).toContain(PLACE.name);
    expect(query).toContain(`${PLACE.lat},${PLACE.lng}`);
  });

  it.each([
    "javascript:alert(document.domain)",
    "data:text/html,<h1>not a map</h1>",
    "https://phishing.example/fake-google-listing",
  ])(
    "rejects an unsafe or non-Google imported URL and uses the safe Google Maps fallback: %s",
    (externalUrl) => {
      render(<NavLinks {...PLACE} externalUrl={externalUrl} />);

      const href = screen.getByTestId("open-google-maps").getAttribute("href");
      expect(href).toMatch(/^https:\/\/www\.google\.com\/maps\/search\//);
    },
  );
});
