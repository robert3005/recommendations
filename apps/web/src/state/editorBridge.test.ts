/** The post editor's pin-tap channel (spec/src/posts.md §Authoring). */
import { describe, expect, it, vi } from "vitest";
import { editorBridge } from "./editorBridge";

describe("editorBridge", () => {
  it("routes pin taps to the registered editor and stops after unregister", () => {
    const onPinTap = vi.fn();
    expect(editorBridge.isRegistered()).toBe(false);

    const unregister = editorBridge.register(onPinTap);
    expect(editorBridge.isRegistered()).toBe(true);
    editorBridge.emitPinTap("place-1");
    expect(onPinTap).toHaveBeenCalledWith("place-1");

    unregister();
    expect(editorBridge.isRegistered()).toBe(false);
    editorBridge.emitPinTap("place-2");
    expect(onPinTap).toHaveBeenCalledOnce();
  });

  it("lets the newest editor win, and a stale unregister cannot evict it", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = editorBridge.register(first);
    const unregisterSecond = editorBridge.register(second);

    editorBridge.emitPinTap("place-1");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("place-1");

    // The superseded editor unmounting must not tear down the live one.
    unregisterFirst();
    expect(editorBridge.isRegistered()).toBe(true);
    editorBridge.emitPinTap("place-2");
    expect(second).toHaveBeenCalledTimes(2);

    unregisterSecond();
    expect(editorBridge.isRegistered()).toBe(false);
  });

  it("emitting with no editor registered is a no-op", () => {
    expect(() => editorBridge.emitPinTap("place-1")).not.toThrow();
  });
});
