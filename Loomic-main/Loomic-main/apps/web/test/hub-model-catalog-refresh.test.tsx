// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ local: true }));
vi.mock("../src/lib/hub-local-runtime", () => ({ isHubLocalRuntime: () => runtime.local }));

import { useLocalModelCatalogRefresh } from "../src/hooks/use-local-model-catalog-refresh";

function focusWindow() {
  act(() => { window.dispatchEvent(new Event("focus")); });
}

function updated(source: MessageEventSource | null = window.parent, type = "adh-model-settings-updated") {
  act(() => { window.dispatchEvent(new MessageEvent("message", { data: { type }, source })); });
}

describe("local model catalog refresh", () => {
  beforeEach(() => { runtime.local = true; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("refreshes when the local canvas regains focus", () => {
    const refresh = vi.fn();
    renderHook(() => useLocalModelCatalogRefresh(refresh));
    refresh.mockClear();
    focusWindow();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes for the settings update sent by its parent window", () => {
    const refresh = vi.fn();
    renderHook(() => useLocalModelCatalogRefresh(refresh));
    refresh.mockClear();
    updated();
    expect(refresh).toHaveBeenCalledTimes(1);
    updated(window.parent, "some-unrelated-parent-message");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("rejects settings messages from other windows or a missing sender", () => {
    const refresh = vi.fn();
    const sibling = document.createElement("iframe");
    document.body.append(sibling);
    try {
      renderHook(() => useLocalModelCatalogRefresh(refresh));
      refresh.mockClear();
      updated(sibling.contentWindow);
      updated(null);
      expect(refresh).not.toHaveBeenCalled();
    } finally { sibling.remove(); }
  });

  it("leaves the original cloud runtime unchanged", () => {
    runtime.local = false;
    const refresh = vi.fn();
    renderHook(() => useLocalModelCatalogRefresh(refresh));
    refresh.mockClear();
    focusWindow(); updated();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not refresh a disabled consumer", () => {
    const refresh = vi.fn();
    renderHook(() => useLocalModelCatalogRefresh(refresh, false));
    refresh.mockClear();
    focusWindow(); updated();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("removes focus and parent-message listeners on unmount", () => {
    const refresh = vi.fn();
    const hook = renderHook(() => useLocalModelCatalogRefresh(refresh));
    refresh.mockClear();
    focusWindow(); updated();
    expect(refresh).toHaveBeenCalledTimes(2);
    hook.unmount(); refresh.mockClear();
    focusWindow(); updated();
    expect(refresh).not.toHaveBeenCalled();
  });
});
