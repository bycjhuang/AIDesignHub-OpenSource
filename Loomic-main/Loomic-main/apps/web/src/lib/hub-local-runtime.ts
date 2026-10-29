/** Local transport for the original Loomic UI. Cloud builds use native fetch. */
export function isHubLocalRuntime() {
  return process.env.NEXT_PUBLIC_HUB_LOCAL_RUNTIME === "1";
}

export function getLocalCapability() {
  if (typeof window === "undefined") return "";
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("loomic-cap");
  if (token) {
    sessionStorage.setItem("loomic-hub-capability", token);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }
  return sessionStorage.getItem("loomic-hub-capability") ?? "";
}

export function getHubProjectId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(location.search);
  const projectId = params.get("hubProjectId") ?? (location.pathname.replace(/\/$/, "") === "/hub" ? params.get("projectId") : null);
  if (projectId) sessionStorage.setItem("loomic-hub-project", projectId);
  return projectId ?? sessionStorage.getItem("loomic-hub-project") ?? "";
}

export async function localFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isHubLocalRuntime() || typeof window === "undefined") return init === undefined ? globalThis.fetch(input) : globalThis.fetch(input, init);
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  // The local adapter must never forward capability headers to a cloud URL
  // present in a previously imported document or generated artifact.
  if (url.origin !== location.origin && url.protocol !== "data:" && url.protocol !== "blob:") {
    throw new Error("本机画布只读取本机素材，请先导入图片文件。");
  }
  if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return init === undefined ? globalThis.fetch(input) : globalThis.fetch(input, init);
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  headers.set("X-Loomic-Token", getLocalCapability());
  headers.set("X-Loomic-Project", getHubProjectId());
  return globalThis.fetch(input, { ...init, headers, credentials: "same-origin" });
}

export function openHubModelSettings(category: "text" | "image" | "video" = "text") {
  window.parent.postMessage({ type: "adh-open-model-settings", category }, "*");
}

export function withHubProjectScope(path: string) {
  if (!isHubLocalRuntime() || typeof window === "undefined") return path;
  const url = new URL(path, location.origin);
  url.searchParams.set("hubProjectId", getHubProjectId());
  return `${url.pathname}${url.search}${url.hash}`;
}
