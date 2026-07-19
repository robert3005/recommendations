/** Phase 5 CORS grants apply to failures as well as successful API responses. */
import { describe, expect, it, vi } from "vitest";
import { createShareApp } from "./app";
import { MemoryStorage } from "./storage";

class ReadFailsStorage extends MemoryStorage {
  override async get(..._args: Parameters<MemoryStorage["get"]>): Promise<undefined> {
    throw new Error("simulated storage outage");
  }
}

describe("Phase 5 CORS error boundary", () => {
  it("grants the separately hosted client access to an unexpected 500 response", async () => {
    const app = createShareApp({ storage: new ReadFailsStorage() });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await app.request("https://share.test/s/lists/unavailable", {
      headers: { origin: "https://app.example" },
    });
    logged.mockRestore();

    expect(response.status).toBe(500);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });
});
