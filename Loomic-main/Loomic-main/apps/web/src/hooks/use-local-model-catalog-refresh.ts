"use client";

import { useEffect, useRef } from "react";
import { isHubLocalRuntime } from "../lib/hub-local-runtime";

/** Refresh the original selectors after their host saves unified model settings. */
export function useLocalModelCatalogRefresh(refresh: () => void, enabled = true) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!isHubLocalRuntime() || !enabled) return;
    const onFocus = () => refreshRef.current();
    const onMessage = (event: MessageEvent) => {
      if (event.source === window.parent && event.data?.type === "adh-model-settings-updated") refreshRef.current();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("message", onMessage);
    return () => { window.removeEventListener("focus", onFocus); window.removeEventListener("message", onMessage); };
  }, [enabled]);
}
