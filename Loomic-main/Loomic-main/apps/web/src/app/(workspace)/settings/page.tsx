"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AgentSection } from "@/components/agent-section";
import { BillingSection } from "@/components/billing-section";
import { CreditUsageHistory } from "@/components/credits/credit-usage-history";
import { ProfileSection } from "@/components/profile-section";
import { SettingsSkeleton } from "@/components/skeletons/settings-skeleton";
import { useAuth } from "@/lib/auth-context";
import { isHubLocalRuntime, openHubModelSettings } from "@/lib/hub-local-runtime";
import {
  ApiAuthError,
  fetchModels,
  fetchViewer,
  fetchWorkspaceSettings,
  updateProfile,
  updateWorkspaceSettings,
} from "@/lib/server-api";

type SettingsTab = "profile" | "agent" | "billing" | "usage";

const tabs: Array<{ id: SettingsTab; label: string }> = [
  { id: "profile", label: "个人资料" },
  { id: "agent", label: "智能体" },
  { id: "billing", label: "账单" },
  { id: "usage", label: "用量" },
];

// Billing & usage belong to the cloud credit system, absent in the desktop app
const visibleTabs = isHubLocalRuntime()
  ? tabs.filter((t) => t.id === "profile" || t.id === "agent")
  : tabs;

export default function SettingsPage() {
  const { session } = useAuth();
  const searchParams = useSearchParams();

  const initialTab = (searchParams.get("tab") as SettingsTab) ?? "profile";
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    visibleTabs.some((t) => t.id === initialTab) ? initialTab : "profile",
  );
  const [profile, setProfile] = useState<{
    displayName: string;
    email: string;
  } | null>(null);
  const [defaultModel, setDefaultModel] = useState<string>("gpt-5.4-mini");
  const [pageLoading, setPageLoading] = useState(true);

  // Ref pattern: prevent token refresh from cascading through dependency arrays
  const accessTokenRef = useRef(session?.access_token);
  accessTokenRef.current = session?.access_token;
  const hasInitialized = useRef(false);

  const getToken = useCallback(() => accessTokenRef.current, []);

  const loadData = useCallback(async () => {
    if (isHubLocalRuntime()) return;
    const token = getToken();
    if (!token) return;
    setPageLoading(true);

    try {
      const [viewer, settings] = await Promise.all([
        fetchViewer(token),
        fetchWorkspaceSettings(token),
      ]);

      setProfile({
        displayName: viewer.profile.displayName,
        email: viewer.profile.email,
      });
      setDefaultModel(settings.settings.defaultModel);
    } catch (err) {
      if (err instanceof ApiAuthError) {
        // Workspace layout handles auth redirect
        return;
      }
    } finally {
      setPageLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (hasInitialized.current) return;
    if (!session?.access_token) return;
    hasInitialized.current = true;
    loadData();
  }, [session?.access_token, loadData]);

  const handleProfileSave = useCallback(
    async (displayName: string) => {
      const token = getToken();
      if (!token) return;
      const result = await updateProfile(token, { displayName });
      setProfile({
        displayName: result.profile.displayName,
        email: result.profile.email,
      });
    },
    [getToken],
  );

  const handleAgentSave = useCallback(
    async (model: string) => {
      const token = getToken();
      if (!token) return;
      const result = await updateWorkspaceSettings(token, {
        defaultModel: model,
      });
      setDefaultModel(result.settings.defaultModel);
    },
    [getToken],
  );

  const stableFetchModels = useCallback(() => fetchModels(), []);

  // Local mode: all model/API configuration is centralized in the Hub settings
  // center, so this page only points back to it instead of duplicating config.
  if (isHubLocalRuntime()) {
    const openSettingsButtonClass =
      "rounded-lg border border-border bg-card px-4 py-2 text-sm text-foreground shadow-sm transition-colors hover:bg-muted";
    return (
      <div className="px-4 py-6 sm:px-6 md:p-8">
        <h1 className="mb-4 text-base font-semibold sm:mb-6 sm:text-lg">
          设置
        </h1>
        <div className="max-w-xl rounded-xl border border-border bg-card p-6 shadow-sm">
          <p className="text-sm font-medium">
            模型与 API 接入已统一到 Hub 设置中心
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            本机模式下，文本、图片、视频模型的 API
            密钥与接入配置全部在 AI Design Hub
            的设置界面统一维护，画布内不再单独设置。密钥只保存在这台电脑，不连接网站、不消耗网站积分。
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className={openSettingsButtonClass}
              onClick={() => openHubModelSettings("text")}
            >
              打开文本模型设置
            </button>
            <button
              type="button"
              className={openSettingsButtonClass}
              onClick={() => openHubModelSettings("image")}
            >
              打开图片模型设置
            </button>
            <button
              type="button"
              className={openSettingsButtonClass}
              onClick={() => openHubModelSettings("video")}
            >
              打开视频模型设置
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (pageLoading) {
    return <SettingsSkeleton />;
  }

  if (!profile) return null;

  return (
    <div className="px-4 py-6 sm:px-6 md:p-8">
      <h1 className="mb-4 text-base font-semibold sm:mb-6 sm:text-lg">
        设置
      </h1>

      {/* Tab bar -- scrollable on small screens, 44px min touch target */}
      <div className="mb-6 overflow-x-auto sm:mb-8">
        <div className="inline-flex gap-1 rounded-lg bg-muted p-1">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`min-h-[44px] whitespace-nowrap rounded-md px-4 py-1.5 text-sm transition-colors sm:min-h-0 sm:px-3 ${
                activeTab === tab.id
                  ? "bg-card font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-xl">
        {activeTab === "profile" ? (
          <ProfileSection
            displayName={profile.displayName}
            email={profile.email}
            onSave={handleProfileSave}
          />
        ) : activeTab === "agent" ? (
          <AgentSection
            defaultModel={defaultModel}
            onSave={handleAgentSave}
            fetchModels={stableFetchModels}
          />
        ) : activeTab === "usage" ? (
          <CreditUsageHistory />
        ) : (
          <BillingSection />
        )}
      </div>
    </div>
  );
}
