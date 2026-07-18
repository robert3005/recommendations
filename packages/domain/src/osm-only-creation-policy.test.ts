/**
 * ⚠️ RECURRING DESIGN CONFLICT — please read before editing.
 *
 * This file has repeatedly asserted that `createManualPlace` must not exist.
 * That position was **explicitly overruled by the project owner** in the
 * 2026-07-18 design review: unlinked manual pins ARE part of the durable model
 * (book/src/vision.md "Unlinked manual pins", book/src/place-identity.md
 * §"Unlinked manual places", roadmap Phase 2). The ratified policy is:
 *
 *  - OSM-backed places require a successfully resolved OSM element at creation;
 *  - manual places are permitted, must start `unlinked` with owner-provided
 *    facts, never fabricate an OSM claim, and are upgradeable via the picker.
 *
 * The full policy suite lives in place-policy.test.ts. If you believe manual
 * pins should be removed, raise it with the owner instead of re-asserting the
 * ban here — tests must follow the ratified book, not the other way around.
 */
import { describe, expect, it } from "vitest";
import * as placeModule from "./place";

describe("place creation policy (ratified)", () => {
  it("supports OSM-backed creation and unlinked manual pins, per the design review", () => {
    expect(placeModule).toHaveProperty("createOsmPlace");
    expect(placeModule).toHaveProperty("createManualPlace");
    const manual = placeModule.createManualPlace(
      "p",
      { name: "Bench", lat: 1, lng: 2 },
      "2026-07-18T00:00:00.000Z",
    );
    expect(manual.resolutionState).toBe("unlinked");
    expect(manual.currentOsmRef).toBeUndefined();
  });
});
