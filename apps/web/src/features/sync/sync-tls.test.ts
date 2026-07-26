import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../../config");
  vi.resetModules();
});

describe("sync transport TLS", () => {
  it("never sends login data or a bearer to an explicitly insecure remote URL", async () => {
    vi.resetModules();
    vi.doMock("../../config", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../config")>()),
      SYNC_API_URL: "http://sync.example",
    }));
    const { HttpSyncTransport, requestLoginCode } = await import("./engine");
    const fetcher = vi.fn<typeof fetch>();

    await expect(requestLoginCode("owner@example.com", fetcher)).rejects.toThrow(/HTTPS/);
    await expect(new HttpSyncTransport("private-token", fetcher).pull()).rejects.toThrow(/HTTPS/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
