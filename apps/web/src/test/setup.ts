import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { server } from "../mocks/server";

/**
 * jsdom + undici realm bridge: components create jsdom AbortSignals (via React Query),
 * but global fetch is Node's undici, which rejects foreign AbortSignal instances with
 * "Expected signal to be an instance of AbortSignal". Bridge by dropping the foreign
 * signal and forwarding abort through a listener-driven passthrough where possible.
 * Must wrap AFTER msw patches fetch, so the validation inside msw's Request build is
 * also bypassed.
 */
function installFetchSignalBridge() {
  const patched = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) {
      // instanceof cannot detect the mismatch (multiple undici copies), so signals
      // are dropped wholesale in jsdom. Abort/cancellation behavior is exercised in
      // the real browser via Playwright, not here.
      const { signal: _foreign, ...rest } = init;
      return patched(input, rest);
    }
    return patched(input, init);
  }) as typeof fetch;
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  installFetchSignalBridge();
});
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

// jsdom gaps for components under test.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}
if (!("ResizeObserver" in window)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (!URL.createObjectURL) {
  URL.createObjectURL = () => "blob:jsdom-stub";
  URL.revokeObjectURL = () => {};
}
