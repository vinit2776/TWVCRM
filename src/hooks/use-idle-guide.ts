"use client";

import { useEffect, useState, useRef } from "react";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { findGuide } from "@/lib/flow-guides";
import type { FlowGuide, UserRole } from "@/lib/flow-guides";

const STORAGE_KEY = (key: string) => `fg_seen_${key}`;
const DEFAULT_IDLE_MS = 10_000;

/**
 * Attention pulse — uses localStorage (persists across sessions) to count
 * how many times the user has interacted with a guide. For the first few
 * encounters the hint card gets a pulsing glow to draw the eye.
 */
const ATTENTION_COUNTER_KEY = "fg_attention_count";
const ATTENTION_THRESHOLD = 3; // stop pulsing after 3 encounters

function getAttentionCount(): number {
  try {
    return parseInt(localStorage.getItem(ATTENTION_COUNTER_KEY) || "0", 10) || 0;
  } catch {
    return 0;
  }
}

function incrementAttentionCount(): void {
  try {
    const next = getAttentionCount() + 1;
    localStorage.setItem(ATTENTION_COUNTER_KEY, String(next));
  } catch {
    // localStorage unavailable — silently skip
  }
}

function hasBeenSeen(key: string): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY(key)) === "1";
  } catch {
    return false;
  }
}

function markSeen(key: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY(key), "1");
  } catch {
    // sessionStorage unavailable — silently skip
  }
}

export function useIdleGuide(): {
  guide: FlowGuide | null;
  dismiss: () => void;
  /** True when the hint should pulse to attract first-time attention */
  shouldPulse: boolean;
} {
  const pathname = usePathname();
  const [activeGuide, setActiveGuide] = useState<FlowGuide | null>(null);
  const [shouldPulse, setShouldPulse] = useState(false);

  // Stable refs — no re-renders needed when these change
  const userRoleRef = useRef<UserRole | null>(null);
  const idleFiredRef = useRef(false);

  // ── Fetch user role once on mount ──────────────────────────────────────────
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data } = await supabase
        .from("users")
        .select("role")
        .eq("auth_id", user.id)
        .single();
      if (data?.role) {
        userRoleRef.current = data.role as UserRole;
        // If the idle timer already fired before the role loaded, retry now
        if (idleFiredRef.current) {
          const guide = findGuide(pathname);
          if (guide) tryShow(guide);
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally runs once

  // ── Idle detection — re-runs on every route change ────────────────────────
  useEffect(() => {
    setActiveGuide(null);
    idleFiredRef.current = false;

    const guide = findGuide(pathname);
    if (!guide) return;

    const idleMs = guide.idleMs ?? DEFAULT_IDLE_MS;
    let timer: ReturnType<typeof setTimeout>;

    const scheduleTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        idleFiredRef.current = true;
        tryShow(guide);
      }, idleMs);
    };

    // On any user activity, reset the idle countdown.
    // Do NOT hide a guide that is already visible — let the user read it.
    const handleActivity = () => scheduleTimer();

    scheduleTimer();

    const events = ["mousemove", "keydown", "click", "scroll", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, handleActivity, { passive: true }));

    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, handleActivity));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]); // re-run only on route change

  /** Show the guide if role check passes and user hasn't seen it this session */
  function tryShow(guide: FlowGuide) {
    if (hasBeenSeen(guide.key)) return;

    if (guide.roles) {
      const role = userRoleRef.current;
      if (!role) return; // role not loaded yet; will retry when role resolves
      if (!guide.roles.includes(role)) return;
    }

    markSeen(guide.key); // mark before showing so rapid re-fires don't double-show
    setActiveGuide(guide);

    // Pulse for the first few encounters to draw attention
    const count = getAttentionCount();
    setShouldPulse(count < ATTENTION_THRESHOLD);
    incrementAttentionCount();
  }

  /** Called when user clicks the × button or the CTA link */
  function dismiss() {
    setActiveGuide(null);
    // already marked seen in tryShow; nothing else to do
  }

  return { guide: activeGuide, dismiss, shouldPulse };
}
