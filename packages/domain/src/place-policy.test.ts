import { describe, expect, it } from "vitest";
import * as placeModule from "./place";

describe("OSM-backed place policy", () => {
  it("does not expose a factory for persistent coordinate-only manual places", () => {
    // Phase 2 requires every newly persisted place to begin with a successfully
    // resolved OSM element. A missing POI is added upstream first; arbitrary
    // coordinate-only places must not enter the durable domain model.
    expect(placeModule).not.toHaveProperty("createManualPlace");
  });
});
