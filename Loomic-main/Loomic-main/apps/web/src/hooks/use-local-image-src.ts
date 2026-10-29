"use client";

import { useEffect, useState } from "react";
import { isHubLocalRuntime, localFetch } from "../lib/hub-local-runtime";

/** Native img elements cannot attach the iframe's local capability header. */
export function useLocalImageSrc(source: string) {
  const protectedSource = isHubLocalRuntime() && !/^(data:|blob:)/.test(source);
  const [resolved, setResolved] = useState<{ source: string; url: string } | null>(null);
  useEffect(() => {
    if (!protectedSource) return;
    const controller = new AbortController();
    let objectUrl = "";
    localFetch(source, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error("本机图片无法读取"); return response.blob(); })
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setResolved({ source, url: objectUrl });
      }).catch(() => {});
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [source, protectedSource]);
  return protectedSource ? resolved?.source === source ? resolved.url : undefined : source;
}
