"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Palette } from "lucide-react";

import type { BrandKitSummary } from "@loomic/shared";
import { fetchBrandKits } from "@/lib/brand-kit-api";
import { updateProject } from "@/lib/server-api";

interface BrandKitSelectorProps {
  accessToken: string;
  projectId: string;
  currentBrandKitId: string | null;
  onBrandKitChange: (kitId: string | null) => void;
}

export function BrandKitSelector({
  accessToken,
  projectId,
  currentBrandKitId,
  onBrandKitChange,
}: BrandKitSelectorProps) {
  const [kits, setKits] = useState<BrandKitSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Use a ref for accessToken to prevent tab-switch reload cascades.
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;

  // Fetch brand kits on mount
  useEffect(() => {
    let cancelled = false;
    fetchBrandKits(accessTokenRef.current)
      .then((res) => {
        if (!cancelled) setKits(res.brandKits);
      })
      .catch(() => {
        /* silently ignore – selector stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const currentKit = kits.find((k) => k.id === currentBrandKitId);
  const label = currentKit ? currentKit.name : "风格套件：无";

  const handleSelect = useCallback(
    async (kitId: string | null) => {
      if (kitId === currentBrandKitId) {
        setOpen(false);
        return;
      }
      setUpdating(true);
      try {
        await updateProject(accessTokenRef.current, projectId, {
          brand_kit_id: kitId,
        });
        onBrandKitChange(kitId);
      } catch {
        /* keep current state on failure */
      } finally {
        setUpdating(false);
        setOpen(false);
      }
    },
    [projectId, currentBrandKitId, onBrandKitChange],
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={updating}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-xl bg-card/80 backdrop-blur-sm border border-border shadow-sm px-3 py-1.5 text-sm transition-colors hover:bg-card/90 disabled:opacity-50"
      >
        <span className="truncate max-w-[120px]">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1.5 min-w-[180px] rounded-xl border bg-popover shadow-lg p-1.5">
          {/* Unbind option */}
          <button
            type="button"
            onClick={() => handleSelect(null)}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-muted transition-colors cursor-pointer"
          >
            <span className="h-4 w-4 shrink-0">
              {currentBrandKitId === null && (
                <Check className="h-4 w-4" />
              )}
            </span>
            <span>无</span>
          </button>

          {/* Kit list */}
          {kits.map((kit) => (
            <button
              key={kit.id}
              type="button"
              onClick={() => handleSelect(kit.id)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-muted transition-colors cursor-pointer"
            >
              <span className="h-4 w-4 shrink-0">
                {kit.id === currentBrandKitId && (
                  <Check className="h-4 w-4" />
                )}
              </span>
              <span className="truncate">{kit.name}</span>
            </button>
          ))}

          {kits.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              暂无风格套件
            </p>
          )}

          {/* Manage / create entry */}
          <div className="mt-1 border-t pt-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                router.push("/brand-kit");
              }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
            >
              <Palette className="h-4 w-4 shrink-0" />
              <span>创建 / 管理风格套件</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
