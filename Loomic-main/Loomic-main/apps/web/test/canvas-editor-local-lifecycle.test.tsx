// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Scene = { elements: any[]; appState: Record<string, any>; files: Record<string, any> };
type Controlled = { props: any; elements: any[]; state: Record<string, any>; files: Record<string, any>; api: any };
const mocks = vi.hoisted(() => ({
  local: true,
  mounts: [] as Controlled[],
  saveCanvas: vi.fn(),
  uploadThumbnail: vi.fn(),
  localFetch: vi.fn(),
  normalize: vi.fn(),
}));

vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return { default: () => function ControlledExcalidraw(props: any) {
    const ref = React.useRef<Controlled | null>(null);
    if (!ref.current) {
      const mount: Controlled = { props, elements: [], state: { isLoading: true }, files: {}, api: null };
      mount.api = {
        getSceneElements: () => mount.elements,
        getSceneElementsIncludingDeleted: () => mount.elements,
        getAppState: () => mount.state,
        getFiles: () => mount.files,
        updateScene: vi.fn(),
        addFiles: vi.fn(),
      };
      ref.current = mount; mocks.mounts.push(mount);
    }
    const mount = ref.current; mount.props = props;
    React.useEffect(() => { props.excalidrawAPI(mount.api); }, []);
    return React.createElement("div", { "data-testid": "controlled-native-editor" });
  } };
});
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("../src/lib/hub-local-runtime", () => ({ isHubLocalRuntime: () => mocks.local, localFetch: mocks.localFetch }));
vi.mock("../src/lib/server-api", () => ({ saveCanvas: mocks.saveCanvas, uploadThumbnail: mocks.uploadThumbnail }));
vi.mock("../src/lib/canvas-normalize", () => ({ normalizeCanvasElements: mocks.normalize }));
vi.mock("../src/lib/env", () => ({ getServerBaseUrl: () => "http://cloud-api.example.test" }));
vi.mock("../src/lib/canvas-elements", () => ({ isVideoUrl: () => false }));
vi.mock("../src/components/canvas-tool-menu", () => ({ CanvasToolMenu: () => null }));
vi.mock("../src/components/canvas/video-canvas-element", () => ({ VideoCanvasElement: () => null }));
vi.mock("../src/components/error-boundary", () => ({ ErrorBoundary: ({ children }: any) => children }));

import { CanvasEditor } from "../src/components/canvas-editor";

const rectangle = { id: "restored-rect", type: "rectangle", version: 74, versionNonce: 14, x: 394, y: 772, width: 156, height: 54, isDeleted: false };
const state = { isLoading: false, viewBackgroundColor: "#ffffff", gridModeEnabled: false, scrollX: 0, scrollY: 0, zoom: { value: 1 }, selectedElementIds: {} };
const original = (): Scene => ({ elements: [{ ...rectangle }], appState: { ...state }, files: {} });

async function settle() { await act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); }); }
async function elapsed(ms = 1600) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); await settle(); }
async function emit(mount: Controlled, elements: any[], files: Record<string, any> = {}, appState = state) {
  await act(async () => {
    mount.elements = elements; mount.files = files; mount.state = appState;
    mount.props.onChange(elements, appState, files);
  });
}
async function mountEditor(content = original(), onApiReady = vi.fn()) {
  const rendered = render(<CanvasEditor canvasId="c1" projectId="p1" accessToken="local-session" initialContent={content} onApiReady={onApiReady} />);
  await settle();
  return { ...rendered, editor: mocks.mounts[0]!, onApiReady };
}

describe("original CanvasEditor local storage lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); mocks.local = true; mocks.mounts.length = 0;
    mocks.saveCanvas.mockResolvedValue(undefined); mocks.uploadThumbnail.mockResolvedValue(undefined);
    mocks.localFetch.mockResolvedValue({ ok: true }); mocks.normalize.mockReturnValue({ changed: false });
  });
  afterEach(async () => { cleanup(); await settle(); vi.clearAllTimers(); vi.useRealTimers(); });

  it("never releases the hydration gate just because the idle callback ran", async () => {
    const { editor } = await mountEditor();
    await elapsed(5);
    await emit(editor, []);
    await elapsed();
    expect(mocks.saveCanvas).not.toHaveBeenCalled();
    await emit(editor, [{ ...rectangle }], {}, { ...state, isLoading: true });
    await elapsed();
    expect(mocks.saveCanvas).not.toHaveBeenCalled();
    await emit(editor, [{ ...rectangle }]);
    await elapsed();
    expect(mocks.saveCanvas).not.toHaveBeenCalled();
    expect(mocks.normalize).not.toHaveBeenCalled();
  });

  it("waits for restored image files and rejects later transient missing files", async () => {
    const image = { id: "restored-image", type: "image", fileId: "f1", version: 1, versionNonce: 2, isDeleted: false };
    const files = { f1: { id: "f1", dataURL: "data:image/png;base64,AA==", mimeType: "image/png", created: 1 } };
    const { editor } = await mountEditor({ elements: [image], appState: { ...state }, files });
    await emit(editor, [image]); await elapsed();
    expect(mocks.saveCanvas).not.toHaveBeenCalled();
    await emit(editor, [image], files); await elapsed();
    expect(mocks.saveCanvas).not.toHaveBeenCalled();
    await emit(editor, [{ ...image, version: 2 }]); await elapsed();
    expect(mocks.saveCanvas).not.toHaveBeenCalled();
  });

  it("rejects bare empty scenes but saves a real deletion with tombstones", async () => {
    const { editor } = await mountEditor();
    await emit(editor, [{ ...rectangle }]);
    await emit(editor, []); await elapsed();
    expect(mocks.saveCanvas).not.toHaveBeenCalled();
    await emit(editor, [{ ...rectangle, version: 75, isDeleted: true }]); await elapsed();
    expect(mocks.saveCanvas).toHaveBeenCalledWith("local-session", "c1", expect.objectContaining({ elements: [] }));
  });

  it("keeps the cloned initial scene and API bridge stable across parent updates", async () => {
    const { editor, rerender } = await mountEditor();
    const initialData = editor.props.initialData; const apiBridge = editor.props.excalidrawAPI;
    rerender(<CanvasEditor canvasId="c1" projectId="p1" accessToken="refreshed-session" initialContent={{ elements: [], appState: {}, files: {} }} onApiReady={vi.fn()} />);
    await settle();
    expect(editor.props.initialData).toBe(initialData);
    expect(editor.props.initialData.elements).toEqual([rectangle]);
    expect(editor.props.excalidrawAPI).toBe(apiBridge);
  });

  it("flushes the accepted snapshot through authenticated localFetch despite a reset API scene", async () => {
    const { editor, unmount } = await mountEditor();
    await emit(editor, [{ ...rectangle }]);
    const moved = { ...rectangle, version: 75, x: 500 };
    await emit(editor, [moved]);
    editor.elements = []; editor.files = {};
    await act(async () => { window.dispatchEvent(new Event("beforeunload")); }); await settle();
    expect(mocks.localFetch).toHaveBeenCalledWith("/api/canvases/c1", expect.objectContaining({ method: "PUT", keepalive: true }));
    const saved = JSON.parse(mocks.localFetch.mock.calls[0]![1].body);
    expect(saved.content.elements).toEqual([moved]);
    unmount(); await settle();
    await emit(editor, []); await elapsed();
    expect(mocks.saveCanvas.mock.calls.every((call) => call[2].elements.length > 0)).toBe(true);
  });

  it("retains the original idle-normalization and cloud saving behavior when local mode is off", async () => {
    mocks.local = false;
    const { editor } = await mountEditor();
    await elapsed(5);
    expect(mocks.normalize).toHaveBeenCalled();
    await emit(editor, [{ ...rectangle, version: 75 }]); await elapsed();
    expect(mocks.saveCanvas).toHaveBeenCalledWith("local-session", "c1", expect.objectContaining({ elements: [expect.objectContaining({ version: 75 })] }));
  });
});
