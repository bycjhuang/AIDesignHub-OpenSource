"use client";

import { useEffect, useState } from "react";
import { isHubLocalRuntime, localFetch, withHubProjectScope } from "../lib/hub-local-runtime";
import { LoadingScreen } from "./loading-screen";

/** Resolve the Hub scope, then enter Loomic's original Home page. */
export function HubBootstrap() {
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        if (!isHubLocalRuntime()) { location.replace("/home"); return; }
        const response = await localFetch("/api/local/context", { signal: controller.signal });
        if (!response.ok) throw new Error("打开本机设计空间失败");
        if (!controller.signal.aborted) location.replace(withHubProjectScope("/home/"));
      } catch (err) { if (!controller.signal.aborted) setError((err as Error).message); }
    })();
    return () => controller.abort();
  }, []);
  if (error) return <main className="flex min-h-screen flex-col items-center justify-center gap-4"><p role="alert">{error}</p><button onClick={() => location.reload()}>重新打开画布</button></main>;
  return <LoadingScreen />;
}
