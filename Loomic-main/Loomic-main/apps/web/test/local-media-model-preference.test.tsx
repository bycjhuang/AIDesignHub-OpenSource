// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useImageModelPreference } from "../src/hooks/use-image-model-preference";
import { useVideoModelPreference } from "../src/hooks/use-video-model-preference";

const catalog = vi.hoisted(() => ({ images: [] as { id: string }[], videos: [] as { id: string }[] }));
vi.mock("../src/lib/server-api", () => ({
  fetchImageModels: vi.fn(async () => ({ models: catalog.images })),
  fetchVideoModels: vi.fn(async () => ({ models: catalog.videos })),
}));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_HUB_LOCAL_RUNTIME", "1");
  localStorage.clear(); catalog.images = []; catalog.videos = [];
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

it("uses only configured image IDs after a parent settings update, never the static Nano Banana ID", async () => {
  localStorage.setItem("loomic:image-model-preference", JSON.stringify({ mode: "manual", models: ["google/nano-banana-pro", "configured-image"] }));
  const { result } = renderHook(() => useImageModelPreference());
  await act(async () => { await Promise.resolve(); });
  expect(result.current.activeImageGenerationPreference).toBeUndefined();
  catalog.images = [{ id: "configured-image" }];
  act(() => window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: { type: "adh-model-settings-updated" } })));
  await waitFor(() => expect(result.current.activeImageGenerationPreference?.models).toEqual(["configured-image"]));
});

it("uses only configured video IDs after focus instead of the static Veo default", async () => {
  localStorage.setItem("loomic:video-model-preference", JSON.stringify({ mode: "manual", models: ["google/veo-3.1", "configured-video"] }));
  const { result } = renderHook(() => useVideoModelPreference());
  await act(async () => { await Promise.resolve(); });
  expect(result.current.activeVideoGenerationPreference).toBeUndefined();
  catalog.videos = [{ id: "configured-video" }];
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(result.current.activeVideoGenerationPreference?.models).toEqual(["configured-video"]));
});
