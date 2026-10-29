// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Element = Record<string, any>;
type EditorProps = {
  initialData: { elements: Element[]; appState: Record<string, any>; files: Record<string, any> };
  onChange: (elements: Element[], state: Record<string, any>, files: Record<string, any>) => void;
  excalidrawAPI: (api: any) => void;
};
type Mount = {
  props: EditorProps;
  renders: EditorProps[];
  elements: Element[];
  state: Record<string, any>;
  files: Record<string, any>;
  api: any;
};

const controlled = vi.hoisted(() => ({ mounts: [] as Mount[] }));
vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    default: () => function ControlledExcalidraw(props: EditorProps) {
      const ref = React.useRef<Mount | null>(null);
      if (!ref.current) {
        const mount: Mount = { props, renders: [], elements: [], state: { isLoading: true }, files: {}, api: null };
        mount.api = {
          getSceneElements: () => mount.elements,
          getSceneElementsIncludingDeleted: () => mount.elements,
          getAppState: () => mount.state,
          getFiles: () => mount.files,
          onChange: () => () => {},
        };
        ref.current = mount;
        controlled.mounts.push(mount);
      }
      const mount = ref.current;
      mount.props = props;
      mount.renders.push(props);
      React.useEffect(() => { props.excalidrawAPI(mount.api); }, []);
      return React.createElement("div", { "data-testid": "controlled-excalidraw" });
    },
  };
});
vi.mock("../src/components/canvas-tool-menu", () => ({ CanvasToolMenu: () => null }));
vi.mock("../src/components/canvas-bottom-bar", () => ({ CanvasBottomBar: () => null }));
vi.mock("../src/components/canvas-layers-panel", () => ({ CanvasLayersPanel: () => null }));
vi.mock("../src/components/canvas-files-panel", () => ({ CanvasFilesPanel: () => null }));

import { HubWorkspace } from "../src/components/hub-workspace";

const rectangle = { id: "saved-rectangle", type: "rectangle", version: 74, versionNonce: 14, x: 394, y: 772, width: 156, height: 54, isDeleted: false };
const appState = { isLoading: false, viewBackgroundColor: "#ffffff", scrollX: 0, scrollY: 0, zoom: { value: 1 }, gridModeEnabled: false };
let documents: Record<string, { id: string; projectId: string; name: string; content: { elements: Element[]; appState: Record<string, any>; files: Record<string, any> } }>;
let writes: { id: string; content: { elements: Element[] } }[];

async function settle() {
  await act(async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); });
}

async function elapsed() {
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  await settle();
}

async function emit(mount: Mount, elements: Element[], state = appState, files: Record<string, any> = {}) {
  await act(async () => {
    mount.elements = elements; mount.state = state; mount.files = files;
    mount.props.onChange(elements, state, files);
  });
}

async function loadWorkspace() {
  render(<HubWorkspace />);
  await settle();
  expect(screen.getByTestId("controlled-excalidraw")).toBeInTheDocument();
  expect(controlled.mounts).toHaveLength(1);
  return controlled.mounts[0]!;
}

describe("HubWorkspace restored-canvas lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    controlled.mounts.length = 0;
    writes = [];
    documents = {
      c1: { id: "c1", projectId: "p1", name: "Existing design", content: { elements: [{ ...rectangle }], appState: { ...appState }, files: {} } },
      c2: { id: "c2", projectId: "p2", name: "Second design", content: { elements: [], appState: { ...appState }, files: {} } },
    };
    history.replaceState(null, "", "/hub/?projectId=lifecycle-fixture");
    sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, options: RequestInit = {}) => {
      const url = String(input);
      let body: unknown;
      if (url === "/api/local/context") body = { projectId: "lifecycle-fixture", projectName: "Lifecycle fixture" };
      else if (url === "/api/local/provider") body = { configured: false, baseUrl: "", model: "", profiles: [] };
      else if (url === "/api/projects") body = { projects: [{ id: "p1", name: "Existing design", canvasId: "c1" }, { id: "p2", name: "Second design", canvasId: "c2" }] };
      else if (url.startsWith("/api/canvases/")) {
        const id = decodeURIComponent(url.slice("/api/canvases/".length));
        if (options.method === "PUT") {
          const content = JSON.parse(String(options.body)).content;
          writes.push({ id, content: structuredClone(content) });
          documents[id]!.content = structuredClone(content);
          body = { ok: true };
        } else body = { canvas: structuredClone(documents[id]) };
      } else throw new Error(`Unexpected local request: ${url}`);
      return { ok: true, status: 200, json: async () => body } as Response;
    }));
  });

  afterEach(async () => {
    cleanup();
    await settle();
    vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
  });

  it("preserves a saved scene when Excalidraw emits empty before restoring its elements", async () => {
    const mount = await loadWorkspace();
    await emit(mount, []);
    await elapsed();
    expect(writes).toHaveLength(0);
    await emit(mount, [{ ...rectangle }], { ...appState, isLoading: true });
    await elapsed();
    expect(writes).toHaveLength(0);
    await emit(mount, [{ ...rectangle }]);
    await elapsed();
    expect(writes).toHaveLength(0);
    expect(documents.c1!.content.elements).toEqual([rectangle]);
  });

  it("rejects a bare empty scene after hydration without deletion tombstones", async () => {
    const mount = await loadWorkspace();
    await emit(mount, [{ ...rectangle }]);
    await elapsed(); writes.length = 0;
    await emit(mount, []);
    await elapsed();
    expect(writes).toHaveLength(0);
    expect(documents.c1!.content.elements).toEqual([rectangle]);
  });

  it("allows an explicit deletion carrying the restored element's tombstone", async () => {
    const mount = await loadWorkspace();
    await emit(mount, [{ ...rectangle }]);
    await elapsed(); writes.length = 0;
    await emit(mount, [{ ...rectangle, version: 75, isDeleted: true }]);
    await elapsed();
    expect(writes).toEqual([{ id: "c1", content: expect.objectContaining({ elements: [] }) }]);
    expect(documents.c1!.content.elements).toEqual([]);
  });

  it("ignores a previous editor's callback after switching to another canvas", async () => {
    const oldMount = await loadWorkspace();
    await emit(oldMount, [{ ...rectangle }]);
    await elapsed(); writes.length = 0;
    await act(async () => { fireEvent.change(screen.getByRole("combobox", { name: "当前设计画布" }), { target: { value: "p2" } }); });
    await settle();
    expect(controlled.mounts).toHaveLength(2);
    const newMount = controlled.mounts[1]!;
    await emit(newMount, []);
    await elapsed(); writes.length = 0;
    await emit(oldMount, [{ ...rectangle, version: 76, x: 900 }]);
    await elapsed();
    expect(writes).toHaveLength(0);
    expect(documents.c2!.content.elements).toEqual([]);
  });

  it("keeps initialData and API callback identities stable through parent-only updates", async () => {
    const mount = await loadWorkspace();
    const baseline = mount.props;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "AI 生图" })); });
    await settle();
    expect(mount.props.initialData).toBe(baseline.initialData);
    expect(mount.props.excalidrawAPI).toBe(baseline.excalidrawAPI);
  });
});
