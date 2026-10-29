// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHubProjectId, localFetch, withHubProjectScope } from "../src/lib/hub-local-runtime";

describe("original Loomic UI local transport", () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    sessionStorage.clear();
    history.replaceState(null, "", "/canvas/?id=loomic-canvas&hubProjectId=hub-project#loomic-cap=local-fixture-cap");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("keeps the native cloud request unchanged when the local flag is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_HUB_LOCAL_RUNTIME", "");
    const options = { headers: { Authorization: "Bearer cloud-fixture" } };
    await localFetch("https://cloud.example/api/projects", options);
    expect(fetchMock).toHaveBeenCalledWith("https://cloud.example/api/projects", options);
    expect(sessionStorage.getItem("loomic-hub-capability")).toBeNull();
  });

  it("authenticates same-origin API calls with the Hub scope, not the Loomic resource ID", async () => {
    vi.stubEnv("NEXT_PUBLIC_HUB_LOCAL_RUNTIME", "1");
    await localFetch("/api/canvases/loomic-canvas", { headers: { "content-type": "application/json" } });
    const [, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(options.headers);
    expect(headers.get("X-Loomic-Token")).toBe("local-fixture-cap");
    expect(headers.get("X-Loomic-Project")).toBe("hub-project");
    expect(headers.get("content-type")).toBe("application/json");
    expect(location.hash).toBe("");
    history.replaceState(null, "", "/canvas/?id=another-design&session=s1");
    expect(getHubProjectId()).toBe("hub-project");
    expect(withHubProjectScope("/home/")).toBe("/home/?hubProjectId=hub-project");
  });

  it("never sends a capability to a cloud URL imported into a local document", async () => {
    vi.stubEnv("NEXT_PUBLIC_HUB_LOCAL_RUNTIME", "1");
    await expect(localFetch("https://external.example/image.png")).rejects.toThrow("本机画布只读取本机素材");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves data URLs readable without attaching local credentials", async () => {
    vi.stubEnv("NEXT_PUBLIC_HUB_LOCAL_RUNTIME", "1");
    const source = "data:image/png;base64,fixture";
    await localFetch(source);
    expect(fetchMock).toHaveBeenCalledWith(source);
  });
});
