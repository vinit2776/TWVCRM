"use client";

import { useCallback, useEffect, useState } from "react";
import { Lightbulb } from "lucide-react";
import { TIPS_EVENT, TIPS_OFF_KEY, readFlag, writeFlag } from "@/lib/package-tour";

export function usePackageTips() {
  const [tipsOn, setTipsOn] = useState(true);

  useEffect(() => {
    const sync = () => setTipsOn(!readFlag(TIPS_OFF_KEY));
    sync();
    window.addEventListener(TIPS_EVENT, sync);
    return () => window.removeEventListener(TIPS_EVENT, sync);
  }, []);

  const setTips = useCallback((on: boolean) => {
    writeFlag(TIPS_OFF_KEY, !on);
    window.dispatchEvent(new Event(TIPS_EVENT));
  }, []);

  return { tipsOn, setTips };
}

/** One-line hint shown beside a decision. Hidden when the user turns tips off. */
export function PackageTip({ children }: { children: React.ReactNode }) {
  const { tipsOn } = usePackageTips();
  if (!tipsOn) return null;
  return (
    <p className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
      <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export function PackageTipsToggle() {
  const { tipsOn, setTips } = usePackageTips();
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <input type="checkbox" checked={tipsOn} onChange={(e) => setTips(e.target.checked)} />
      Show tips
    </label>
  );
}
