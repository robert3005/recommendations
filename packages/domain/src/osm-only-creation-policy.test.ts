import { describe, expect, it } from "vitest";
import * as placeModule from "./place";

describe("OSM-only place creation policy", () => {
  it("does not permit a persisted place without an existing OSM POI", () => {
    // Product decision: creation must resolve and link an existing OSM POI.
    // If the POI is missing, the user is forwarded to update OSM and retries
    // after the upstream element exists; coordinate-only manual places are not
    // a supported durable identity.
    expect(placeModule).toHaveProperty("createOsmPlace");
    expect(placeModule).not.toHaveProperty("createManualPlace");
  });
});
