"use client";

import "@excalidraw/excalidraw/index.css";
import "./hub-workspace.css";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { CanvasToolMenu } from "./canvas-tool-menu";
import { CanvasBottomBar } from "./canvas-bottom-bar";
import { CanvasLayersPanel } from "./canvas-layers-panel";
import { CanvasFilesPanel } from "./canvas-files-panel";

const Excalidraw = dynamic(async () => {
  (window as any).EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";
  return (await import("@excalidraw/excalidraw")).Excalidraw;
}, { ssr: false, loading: () => <div className="hub-loading">正在载入画布…</div> });

type Content = {
  elements: Record<string, any>[];
  appState: Record<string, any>;
  files: Record<string, any>;
};
type Design = { id: string; name: string; canvasId?: string; defaultCanvasId?: string };
type Canvas = { id: string; projectId: string; name: string; content: Content };
type LoadedCanvas = Canvas & { loadId: number };
type ImageProfile = { id: string; name: string; model: string; configured?: boolean };
type Provider = { configured: boolean; baseUrl: string; model: string; canGenerate?: boolean; profiles?: ImageProfile[]; defaultProfileId?: string };
type Context = { projectId: string; projectName: string; notice?: string };
const EMPTY: Content = { elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {} };

function localHeaders(): Record<string, string> {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const fragmentToken = fragment.get("loomic-cap");
  if (fragmentToken) {
    sessionStorage.setItem("loomic-hub-capability", fragmentToken);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }
  const token = sessionStorage.getItem("loomic-hub-capability");
  const projectId = new URLSearchParams(location.search).get("projectId");
  return { ...(token ? { "X-Loomic-Token": token } : {}), ...(projectId ? { "X-Loomic-Project": projectId } : {}) };
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...localHeaders(), ...options.headers },
    credentials: "same-origin",
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message ?? result?.message ?? `本机服务请求失败 (${response.status})`);
  return result as T;
}

function sceneContent(elements: readonly any[], appState: any, files: Record<string, any>): Content {
  return {
    elements: elements.filter((element) => !element.isDeleted),
    appState: {
      viewBackgroundColor: appState.viewBackgroundColor,
      gridSize: appState.gridSize,
      gridModeEnabled: appState.gridModeEnabled,
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom,
      exportBackground: appState.exportBackground,
    },
    files,
  };
}

function contentSignature(content: Content) {
  // Binary file data is immutable for a file ID. Do not stringify megabytes of
  // image data on every pointer move just to detect a new scene version.
  return JSON.stringify({
    elements: content.elements.map((item) => [item.id, item.version, item.versionNonce]),
    appState: content.appState,
    files: Object.keys(content.files).sort(),
  });
}

function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取图片"));
    reader.readAsDataURL(blob);
  });
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function HubWorkspace() {
  const [context, setContext] = useState<Context | null>(null);
  const [designs, setDesigns] = useState<Design[]>([]);
  const [canvas, setCanvas] = useState<LoadedCanvas | null>(null);
  const [hasElements, setHasElements] = useState(false);
  const [api, setApi] = useState<any>(null);
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState("本机保存");
  const [busy, setBusy] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [profileId, setProfileId] = useState("");
  const [nameDialog, setNameDialog] = useState<{ mode: "create" | "rename"; value: string } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [imageSize, setImageSize] = useState("1024x1024");
  const [generating, setGenerating] = useState(false);
  const [generationNotice, setGenerationNotice] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<LoadedCanvas | null>(null);
  const mountedRef = useRef(false);
  const loadSequenceRef = useRef(0);
  const apiRef = useRef<any>(null);
  const dirtyRef = useRef(false);
  const hydratedRef = useRef(false);
  const revisionRef = useRef(0);
  const latestRef = useRef<Content | null>(null);
  const lastSignatureRef = useRef("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef<Promise<void>>(Promise.resolve());
  const generationLockRef = useRef(false);

  const save = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (!hydratedRef.current || !dirtyRef.current || !latestRef.current || !canvasRef.current) return;
    // Freeze both destination and body when enqueuing. A later canvas switch
    // must never redirect a queued write to the newly opened document.
    const revision = revisionRef.current;
    const currentCanvas = canvasRef.current;
    const body = JSON.stringify({ content: latestRef.current });
    const pending = async () => {
      if (mountedRef.current && canvasRef.current === currentCanvas) setSaveStatus("正在保存…");
      try {
        await request(`/api/canvases/${encodeURIComponent(currentCanvas.id)}`, {
          method: "PUT", body,
        });
        if (revision === revisionRef.current && currentCanvas === canvasRef.current) {
          dirtyRef.current = false;
          if (mountedRef.current) setSaveStatus("已保存到本机");
        }
      } catch (err) {
        if (mountedRef.current && canvasRef.current === currentCanvas) setSaveStatus("保存失败 · 请重试");
        throw err;
      }
    };
    const next = savingRef.current.catch(() => {}).then(pending);
    savingRef.current = next;
    return next;
  }, []);

  const handleChange = useCallback((loadId: number | undefined, elements: readonly any[], state: any, files: Record<string, any>) => {
    const current = canvasRef.current;
    if (!mountedRef.current || !current || current.loadId !== loadId || state.isLoading) return;
    // Excalidraw emits an empty scene during hydration. Only edits after the
    // supplied scene is visible can replace an existing saved document.
    if (!hydratedRef.current) {
      const expected = current.content.elements.filter((element) => !element.isDeleted);
      if (expected.length && !expected.every((element) => elements.some((live) => live.id === element.id))) return;
      const expectedFileIds = expected.filter((element) => element.type === "image" && element.fileId && current.content.files[element.fileId]).map((element) => element.fileId);
      if (!expectedFileIds.every((fileId) => files[fileId])) return;
      hydratedRef.current = true;
      // Restoration is a baseline, not an edit. In particular, default app
      // state and image-file hydration must not immediately rewrite the file.
      if (expected.length || !elements.some((element) => !element.isDeleted)) {
        latestRef.current = sceneContent(elements, state, files);
        lastSignatureRef.current = contentSignature(latestRef.current);
        setHasElements(expected.length > 0);
        return;
      }
    }
    const previous = latestRef.current?.elements ?? [];
    if (previous.length && !elements.some((element) => !element.isDeleted)) {
      // A reset/unmount can emit a bare empty scene. Actual Excalidraw deletion
      // retains tombstones for removed elements, so require that evidence
      // before an empty scene may replace a non-empty saved document.
      if (!previous.every((element) => elements.some((candidate) => candidate.id === element.id && candidate.isDeleted))) return;
    }
    const content = sceneContent(elements, state, files);
    setHasElements(content.elements.length > 0);
    const signature = contentSignature(content);
    if (signature === lastSignatureRef.current) return;
    lastSignatureRef.current = signature;
    latestRef.current = content;
    dirtyRef.current = true;
    revisionRef.current += 1;
    setSaveStatus("有修改 · 即将保存");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { save().catch((err) => setError(err.message)); }, 750);
  }, [save]);

  const openCanvas = useCallback(async (id: string, signal?: AbortSignal) => {
    const loadId = ++loadSequenceRef.current;
    const data = await request<{ canvas: Canvas }>(`/api/canvases/${encodeURIComponent(id)}`, signal ? { signal } : {});
    if (!mountedRef.current || signal?.aborted || loadId !== loadSequenceRef.current) return;
    const next = { ...data.canvas, loadId, content: structuredClone({ ...EMPTY, ...data.canvas.content }) };
    canvasRef.current = next;
    latestRef.current = next.content;
    hydratedRef.current = false;
    dirtyRef.current = false;
    lastSignatureRef.current = contentSignature(next.content);
    apiRef.current = null;
    setApi(null);
    setCanvas(next);
    setHasElements(next.content.elements.some((element) => !element.isDeleted));
    setSaveStatus("已保存到本机");
  }, []);

  const refreshDesigns = useCallback(async (signal?: AbortSignal) => {
    const data = await request<{ projects: Design[] }>("/api/projects", signal ? { signal } : {});
    if (!mountedRef.current || signal?.aborted) return [];
    setDesigns(data.projects);
    return data.projects;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    const controller = new AbortController();
    (async () => {
      try {
        const current = await request<Context>("/api/local/context", { signal: controller.signal });
        if (!active) return;
        setContext(current);
        const list = await refreshDesigns(controller.signal);
        if (!active) return;
        const first = list[0];
        if (first) await openCanvas(first.canvasId ?? first.defaultCanvasId ?? first.id, controller.signal);
        else {
          const created = await request<{ project: Design; canvas: { id: string } }>("/api/projects", {
            method: "POST", body: JSON.stringify({ name: "未命名设计" }), signal: controller.signal,
          });
          if (!active) return;
          await refreshDesigns(controller.signal);
          if (!active) return;
          await openCanvas(created.canvas.id, controller.signal);
        }
        if (!active) return;
        const status = await request<Provider>("/api/local/provider", { signal: controller.signal });
        if (!active) return;
        setProvider(status); setProfileId(status.defaultProfileId ?? "");
      } catch (err) { if (active) setError((err as Error).message); }
    })();
    const onVisibility = () => { if (document.hidden) save().catch(() => {}); };
    const onUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) { event.preventDefault(); event.returnValue = ""; save().catch(() => {}); }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      active = false;
      mountedRef.current = false;
      controller.abort();
      loadSequenceRef.current += 1;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onUnload);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      save().catch(() => {});
    };
  }, [openCanvas, refreshDesigns, save]);

  const initialData = useMemo(() => {
    if (!canvas) return null;
    const content = structuredClone(canvas.content);
    return {
      ...content,
      appState: { ...content.appState, activeTool: { type: "selection", locked: false, lastActiveTool: null, customType: null }, selectedElementIds: {}, selectedGroupIds: {} },
    };
  }, [canvas]);
  const handleSceneChange = useCallback((elements: readonly any[], state: any, files: Record<string, any>) => {
    handleChange(canvas?.loadId, elements, state, files);
  }, [canvas?.loadId, handleChange]);
  const handleApiReady = useCallback((editor: any) => {
    if (canvasRef.current?.loadId !== canvas?.loadId) return;
    apiRef.current = editor;
    setApi(editor);
  }, [canvas?.loadId]);

  const refreshProvider = useCallback(async () => {
    try {
      const status = await request<Provider>("/api/local/provider");
      setProvider(status);
      setProfileId((current) => status.profiles?.some((item) => item.id === current) ? current : status.defaultProfileId ?? "");
    } catch (err) { setError((err as Error).message); }
  }, []);

  useEffect(() => {
    const onFocus = () => { refreshProvider(); };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      if (event.data?.type === "adh-model-settings-updated") refreshProvider();
      if (event.data?.type === "adh-canvas-immersive") { setAiOpen(false); setLayersOpen(false); setFilesOpen(false); }
    };
    window.addEventListener("focus", onFocus); window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "adh-canvas-ready" }, "*");
    return () => { window.removeEventListener("focus", onFocus); window.removeEventListener("message", onMessage); };
  }, [refreshProvider]);

  async function action(work: () => Promise<void>) {
    if (busy || generating) return;
    setBusy(true); setError("");
    try { await work(); } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function switchDesign(id: string) {
    await action(async () => {
      await save();
      const design = designs.find((item) => item.id === id);
      if (design) await openCanvas(design.canvasId ?? design.defaultCanvasId ?? design.id);
    });
  }

  async function createDesign(name: string) {
    if (!name.trim()) return;
    await action(async () => {
      await save();
      const result = await request<{ project: Design; canvas: { id: string } }>("/api/projects", {
        method: "POST", body: JSON.stringify({ name: name.trim() }),
      });
      await refreshDesigns(); await openCanvas(result.canvas.id); setNameDialog(null);
    });
  }

  async function renameDesign(name: string) {
    if (!canvas) return;
    if (!name.trim()) return;
    await action(async () => {
      await request(`/api/projects/${encodeURIComponent(canvas.projectId)}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
      await refreshDesigns(); setNameDialog(null);
    });
  }

  async function insertImage(blob: Blob, label?: string) {
    const editor = apiRef.current;
    if (!editor) throw new Error("画布尚未就绪");
    const dataURL = await asDataUrl(blob);
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    const width = bitmap.width * scale; const height = bitmap.height * scale;
    bitmap.close();
    const state = editor.getAppState();
    const fileId = crypto.randomUUID();
    const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");
    const elements = convertToExcalidrawElements([{
      type: "image", fileId, status: "saved", width, height,
      x: -state.scrollX + state.width / state.zoom.value / 2 - width / 2,
      y: -state.scrollY + state.height / state.zoom.value / 2 - height / 2,
      customData: label ? { title: label } : undefined,
    } as any]);
    editor.addFiles([{ id: fileId, dataURL, mimeType: blob.type || "image/png", created: Date.now() }]);
    editor.updateScene({ elements: [...editor.getSceneElements(), ...elements], captureUpdate: "IMMEDIATELY" });
    editor.scrollToContent(elements, { fitToContent: true });
    handleChange(canvasRef.current?.loadId, editor.getSceneElements(), editor.getAppState(), editor.getFiles());
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []); event.target.value = "";
    if (!files.length || !apiRef.current) return;
    await action(async () => {
      for (const file of files) {
        if (file.type.startsWith("image/")) { await insertImage(file, file.name); continue; }
        const imported = JSON.parse(await file.text());
        const content = imported.content ?? imported;
        if (!Array.isArray(content.elements)) throw new Error("请选择 Excalidraw 画布或包含 elements 的 JSON 文件");
        await save();
        const result = await request<{ project: Design; canvas: { id: string } }>("/api/projects", {
          method: "POST", body: JSON.stringify({ name: file.name.replace(/\.(excalidraw|json)$/i, "") }),
        });
        await request(`/api/canvases/${encodeURIComponent(result.canvas.id)}`, {
          method: "PUT", body: JSON.stringify({ content: { elements: content.elements, appState: content.appState ?? {}, files: content.files ?? {} } }),
        });
        await refreshDesigns(); await openCanvas(result.canvas.id);
      }
      await save();
    });
  }

  async function exportFile(kind: "scene" | "png") {
    await action(async () => {
      const editor = apiRef.current; if (!editor) return;
      const { exportToBlob, serializeAsJSON } = await import("@excalidraw/excalidraw");
      const elements = editor.getSceneElements(); const state = editor.getAppState(); const files = editor.getFiles();
      const name = designs.find((item) => item.id === canvas?.projectId)?.name ?? "AI Design";
      const blob = kind === "scene"
        ? new Blob([serializeAsJSON(elements, state, files, "local")], { type: "application/json" })
        : await exportToBlob({ elements, appState: { ...state, exportBackground: true }, files, mimeType: "image/png" });
      const output = kind === "png" ? await (await import("@/lib/export-provenance")).brandCanvasExport(blob) : blob;
      download(output, `${name.replace(/[<>:"/\\|?*]/g, "-")}.${kind === "scene" ? "excalidraw" : "png"}`);
    });
  }

  function openSettings() {
    window.parent.postMessage({ type: "adh-open-model-settings", category: "image" }, "*");
  }

  async function generate() {
    if (generationLockRef.current || !prompt.trim() || !provider?.configured || !canvasRef.current) return;
    generationLockRef.current = true; setGenerating(true); setError(""); setGenerationNotice("正在请求生图接口…");
    try {
      const result = await request<{ images: { url?: string; dataUrl?: string; mimeType?: string }[] }>("/api/local/generate", {
        method: "POST", body: JSON.stringify({ prompt: prompt.trim(), model: provider.profiles?.find((item) => item.id === profileId)?.model ?? provider.model, ...(profileId ? { profileId } : {}), size: imageSize, canvasId: canvasRef.current.id, requestId: crypto.randomUUID() }),
      });
      if (!result.images?.length) throw new Error("接口未返回图片，请检查服务结果");
      for (const image of result.images) {
        const url = image.dataUrl ?? image.url;
        if (!url || (!url.startsWith("data:image/") && new URL(url, location.origin).origin !== location.origin)) throw new Error("本机服务返回了无效图片地址");
        const response = await fetch(url, { headers: localHeaders(), credentials: "same-origin" }); if (!response.ok) throw new Error("读取生成图片失败");
        await insertImage(await response.blob(), prompt.trim().slice(0, 40));
      }
      await save(); setGenerationNotice(`已将 ${result.images.length} 张图片加入画布并保存`);
    } catch (err) { setError((err as Error).message); setGenerationNotice("生成未完成，提示词已保留。可查看错误后再手动操作。"); }
    finally { generationLockRef.current = false; setGenerating(false); }
  }

  return (
    <main className="hub-workspace">
      <header className="hub-header">
        <div className="hub-heading"><strong>AI Design</strong><span title={context?.projectName}>{context?.projectName ?? "本机设计画布"}</span></div>
        <select aria-label="当前设计画布" value={canvas?.projectId ?? ""} disabled={busy || generating} onChange={(event) => switchDesign(event.target.value)}>
          {!designs.length && <option value="">正在读取…</option>}
          {designs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button onClick={() => setNameDialog({ mode: "create", value: "未命名设计" })} disabled={busy || generating}>新建</button>
        <button onClick={() => setNameDialog({ mode: "rename", value: designs.find((item) => item.id === canvas?.projectId)?.name ?? canvas?.name ?? "" })} disabled={!canvas || busy || generating}>重命名</button>
        <span className={`hub-save-status ${saveStatus.includes("失败") ? "has-error" : ""}`} role="status">{saveStatus}</span>
        <div className="hub-header-actions">
          <button onClick={() => inputRef.current?.click()} disabled={!api || busy || generating}>导入</button>
          <button onClick={() => exportFile("scene")} disabled={!api || busy}>导出画布</button>
          <button onClick={() => exportFile("png")} disabled={!api || busy}>导出 PNG</button>
          <button onClick={() => action(save)} disabled={!canvas || busy}>保存</button>
          <button className={aiOpen ? "is-active" : ""} onClick={() => setAiOpen(!aiOpen)}>AI 生图</button>
        </div>
        <input ref={inputRef} type="file" accept=".excalidraw,.json,image/png,image/jpeg,image/webp,image/gif,image/svg+xml" multiple hidden onChange={importFile} />
      </header>
      {error && <div className="hub-error" role="alert"><span>{error}</span><button aria-label="关闭错误" onClick={() => setError("")}>×</button></div>}
      <div className="hub-body">
        <section className="hub-canvas" aria-label="设计画布">
          {canvas ? <Excalidraw key={`${canvas.id}:${canvas.loadId}`} langCode="zh-CN" initialData={initialData as any} onChange={handleSceneChange} excalidrawAPI={handleApiReady} theme="light" /> : <div className="hub-loading">{error ? "画布暂时无法载入" : "正在打开本机设计画布…"}</div>}
          {api && <>
            <CanvasToolMenu accessToken="" excalidrawApi={api} leftPanelOpen={layersOpen || filesOpen} localOnly />
            <CanvasBottomBar excalidrawApi={api} layersOpen={layersOpen} onToggleLayers={() => { setLayersOpen(!layersOpen); setFilesOpen(false); }} filesOpen={filesOpen} onToggleFiles={() => { setFilesOpen(!filesOpen); setLayersOpen(false); }} leftPanelOpen={layersOpen || filesOpen} />
            <CanvasLayersPanel excalidrawApi={api} open={layersOpen} onClose={() => setLayersOpen(false)} />
            <CanvasFilesPanel excalidrawApi={api} open={filesOpen} onClose={() => setFilesOpen(false)} />
          </>}
          {canvas && !hasElements && <div className="hub-canvas-hint">自由绘图，或导入图片开始设计<span>画布随当前 Hub 项目单独保存在本机</span></div>}
        </section>
        {aiOpen && <aside className="hub-ai-panel" aria-label="AI 生图面板">
          <div className="hub-ai-title"><strong>AI 生图</strong><button onClick={openSettings} aria-label="打开 Hub 模型设置">模型设置</button></div>
          <p className="hub-muted">描述画面，生成的图片会直接加入当前设计画布。</p>
          <div className={`hub-provider-status ${provider?.configured ? "is-ready" : ""}`}><i />{provider?.configured ? "Hub 生图模型已配置" : "尚未配置生图模型"}</div>
          <label><span>模型 <button className="hub-refresh-models" onClick={refreshProvider} disabled={generating}>刷新</button></span>{provider?.profiles?.length ? <select value={profileId} onChange={(event) => setProfileId(event.target.value)} disabled={generating}><option value="">{provider.model || "使用 Hub 默认生图模型"}</option>{provider.profiles.map((item) => <option key={item.id} value={item.id} disabled={item.configured === false}>{item.name || item.model}</option>)}</select> : <input value={provider?.model ?? ""} readOnly placeholder="请在 Hub 模型设置中配置" />}</label>
          <label>画面描述<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：现代建筑展厅，温暖的自然光，浅色木材与混凝土，建筑摄影" rows={7} disabled={generating} /></label>
          <label>尺寸<select value={imageSize} onChange={(event) => setImageSize(event.target.value)} disabled={generating}><option value="1024x1024">方形 1024 × 1024</option><option value="1536x1024">横向 1536 × 1024</option><option value="1024x1536">竖向 1024 × 1536</option></select></label>
          {provider?.configured ? <button className="hub-primary" disabled={!prompt.trim() || generating || !api || busy} onClick={generate}>{generating ? "正在生成…" : "生成图片"}</button> : <button className="hub-primary" onClick={openSettings}>打开 Hub 模型设置</button>}
          <p className="hub-muted">点击生成时才请求所配置的服务，费用按服务方规则计算。</p>
          {generationNotice && <p className="hub-generation-notice" role="status">{generationNotice}</p>}
          <div className="hub-local-note"><strong>本机项目空间</strong><span>设计文档、素材与生成结果保存在当前电脑；切换 Hub 项目后分别管理。</span><small>Canvas powered by Loomic · Excalidraw</small></div>
        </aside>}
      </div>
      {nameDialog && <div className="hub-modal-backdrop">
        <form className="hub-modal" role="dialog" aria-modal="true" aria-labelledby="hub-name-title" onSubmit={(event) => { event.preventDefault(); if (nameDialog.mode === "create") createDesign(nameDialog.value); else renameDesign(nameDialog.value); }}>
          <h2 id="hub-name-title">{nameDialog.mode === "create" ? "新建设计画布" : "重命名设计画布"}</h2>
          <label>设计名称<input autoFocus value={nameDialog.value} onChange={(event) => setNameDialog({ ...nameDialog, value: event.target.value })} maxLength={160} /></label>
          <div className="hub-modal-actions"><button type="button" disabled={busy} onClick={() => setNameDialog(null)}>取消</button><button type="submit" className="hub-primary" disabled={busy || !nameDialog.value.trim()}>{busy ? "保存中…" : "确定"}</button></div>
        </form>
      </div>}
    </main>
  );
}
