"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { VideoGenerationPreference } from "@loomic/shared";
import { isHubLocalRuntime } from "../lib/hub-local-runtime";
import { fetchVideoModels } from "../lib/server-api";
import { useLocalModelCatalogRefresh } from "./use-local-model-catalog-refresh";

const STORAGE_KEY = "loomic:video-model-preference";
const DEFAULT_MODEL = "google/veo-3.1";

export type VideoModelPreference = VideoGenerationPreference;

const defaultPreference: VideoModelPreference = {
  mode: "auto",
  models: isHubLocalRuntime() ? [] : [DEFAULT_MODEL],
};

const listeners = new Set<() => void>();
function emitChange() {
  for (const listener of listeners) listener();
}

let cachedRaw: string | null = null;
let cachedPreference: VideoModelPreference = defaultPreference;

function getSnapshot(): VideoModelPreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      cachedPreference = raw
        ? normalizePreference(JSON.parse(raw) as Partial<VideoModelPreference> & { model?: string })
        : defaultPreference;
    }
    return cachedPreference;
  } catch {
    return defaultPreference;
  }
}

function getServerSnapshot(): VideoModelPreference {
  return defaultPreference;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function normalizePreference(
  preference?: Partial<VideoModelPreference> & { model?: string },
): VideoModelPreference {
  if (!preference) return defaultPreference;

  const models = Array.isArray(preference.models)
    ? preference.models.filter(
        (model): model is string => typeof model === "string" && model.length > 0,
      )
    : typeof preference.model === "string" && preference.model.length > 0
      ? [preference.model]
      : defaultPreference.models;

  return {
    mode: preference.mode === "manual" ? "manual" : "auto",
    models: models.length > 0 ? models : defaultPreference.models,
  };
}

export function useVideoModelPreference() {
  const preference = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [localModelIds, setLocalModelIds] = useState<string[]>([]);
  const refreshLocalCatalog = useCallback(() => {
    if (isHubLocalRuntime()) void fetchVideoModels().then((result) => setLocalModelIds(result.models.filter((item) => item.accessible !== false).map((item) => item.id))).catch(() => setLocalModelIds([]));
  }, []);
  useEffect(refreshLocalCatalog, [refreshLocalCatalog]);
  useLocalModelCatalogRefresh(refreshLocalCatalog);

  const setPreference = useCallback((next: VideoModelPreference) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    emitChange();
  }, []);

  const setMode = useCallback(
    (mode: "auto" | "manual") => {
      setPreference({ ...preference, mode });
    },
    [preference, setPreference],
  );

  const toggleModel = useCallback(
    (model: string) => {
      const isSelected = preference.models.includes(model);

      if (isSelected && preference.models.length === 1) {
        return;
      }

      const models = isSelected
        ? preference.models.filter((item) => item !== model)
        : [...preference.models, model];

      setPreference({
        mode: "manual",
        models,
      });
    },
    [preference.models, setPreference],
  );

  const availablePreference = isHubLocalRuntime() ? { ...preference, models: preference.models.filter((model) => localModelIds.includes(model)) } : preference;
  const activeVideoGenerationPreference =
    availablePreference.mode === "manual" && availablePreference.models.length > 0
      ? availablePreference
      : undefined;

  return {
    preference,
    setPreference,
    setMode,
    toggleModel,
    activeVideoGenerationPreference,
  };
}
