"use client";

import { useEffect, useRef } from "react";
import { fetchLocalImageGenerations } from "../lib/server-api";
import { isHubLocalRuntime } from "../lib/hub-local-runtime";
import { fetchAsDataURL } from "../lib/canvas-elements";
import { completeImageGeneratorElement, isImageGeneratorElement, updateImageGeneratorElement } from "../lib/canvas-image-generator";

/** Read local receipts only; recovery never submits another generation. */
export function useLocalImageGenerationRecovery(api: any, accessToken: string) {
  const tokenRef = useRef(accessToken);
  tokenRef.current = accessToken;
  useEffect(() => {
    if (!isHubLocalRuntime() || !api) return;
    const canvasId = new URLSearchParams(location.search).get("id");
    if (!canvasId) return;
    let active = true;
    let busy = false;
    const recover = async () => {
      if (!active || busy) return;
      const pending = api.getSceneElements().filter((element: any) => !element.isDeleted && isImageGeneratorElement(element) && element.customData.status === "generating");
      if (!pending.length) return;
      busy = true;
      try {
        const { generations } = await fetchLocalImageGenerations(tokenRef.current, canvasId);
        for (const element of pending) {
          if (!active) return;
          const data = element.customData;
          // Old placeholders predate request IDs. Recover only an unambiguous
          // prompt/model match in this canvas, never a result from another one.
          const samePrompt = pending.filter((other: any) => other.customData.prompt === data.prompt && other.customData.model === data.model);
          const receipt = data.requestId ? generations.find(row => row.requestId === data.requestId)
            : samePrompt.length === 1 ? generations.filter(row => row.prompt === data.prompt && row.profileId === data.model).at(-1) : undefined;
          if (!receipt) {
            if (!data.requestId || data.requestStartedAt && Date.now() - data.requestStartedAt > 300000) updateImageGeneratorElement(api, element.id, { status: "error", errorMessage: "没有找到可确认的生成结果，请先检查服务记录；没有重新提交请求。" });
            continue;
          }
          if (receipt.status === "generating") continue;
          const image = receipt.images?.[0];
          if (receipt.status === "completed" && image) {
            const dataURL = await fetchAsDataURL(image.url);
            if (active) completeImageGeneratorElement(api, element.id, { dataURL, mimeType: image.mimeType, title: data.prompt.slice(0, 60) });
          } else {
            updateImageGeneratorElement(api, element.id, { status: "error", errorMessage: receipt.error?.message || "这次生成的结果尚未确认，请先检查服务记录；没有重新提交请求。" });
          }
        }
      } catch (error) { console.warn("[image-gen] Local result recovery is waiting:", error); }
      finally { busy = false; }
    };
    void recover();
    const timer = setInterval(() => void recover(), 2000);
    return () => { active = false; clearInterval(timer); };
  }, [api]);
}
