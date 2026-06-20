"use client";

import { useRouter } from "next/navigation";
import { Check, UserCheck, X, RefreshCw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEnquiryNotifications } from "@/providers/enquiry-notifications-provider";
import type { EnquiryItem, ResolutionOutcome } from "@/providers/enquiry-notifications-provider";

const OUTCOME_LABEL: Record<ResolutionOutcome, string> = {
  converted: "Converted to lead",
  not_interested: "Not interested / no fit",
  no_response: "Followed up — no response",
};

const OUTCOME_BG: Record<ResolutionOutcome, string> = {
  converted: "bg-emerald-100 text-emerald-800",
  not_interested: "bg-slate-100 text-slate-700",
  no_response: "bg-amber-100 text-amber-800",
};

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function urgency(item: EnquiryItem): "red" | "yellow" | "stale" | "ok" {
  if (item.resolvedAt) return "ok";
  const now = Date.now();
  if (!item.claimedAt) {
    const ageMs = now - new Date(item.attentionResetAt).getTime();
    if (ageMs >= 4 * 3600 * 1000) return "red";
    if (ageMs >= 2 * 3600 * 1000) return "yellow";
    return "ok";
  }
  const claimAgeMs = now - new Date(item.claimedAt).getTime();
  if (claimAgeMs >= 24 * 3600 * 1000) return "stale";
  return "ok";
}

interface Props {
  item: EnquiryItem;
  onNavigate?: () => void;
  compact?: boolean;
}

export function EnquiryQueueRow({ item, onNavigate, compact = false }: Props) {
  const router = useRouter();
  const { claim, unclaim, resolve } = useEnquiryNotifications();

  const u = urgency(item);
  const isResolved = !!item.resolvedAt;

  const borderClass = isResolved
    ? "border-slate-200 bg-slate-50/60 opacity-70"
    : u === "red"
      ? "border-red-300 bg-red-50/40"
      : u === "yellow"
        ? "border-amber-300 bg-amber-50/40"
        : u === "stale"
          ? "border-orange-200 bg-orange-50/30"
          : "border-slate-200 bg-white";

  function goToLead() {
    onNavigate?.();
    router.push(`/leads/${item.leadId}`);
  }

  return (
    <div
      className={`rounded-lg border ${borderClass} ${compact ? "px-2.5 py-2" : "px-3 py-2.5"} transition-colors`}
    >
      <div className="flex items-start justify-between gap-2">
        <button onClick={goToLead} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-medium truncate">{item.name}</span>
            {item.isReEnquiry && !isResolved && (
              <span
                className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
                title="Customer has re-submitted the form"
              >
                <RefreshCw className="h-2.5 w-2.5" />
                Re-enquiry
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate">
            {item.source}
            {!compact && item.mobile && <> · +91 {item.mobile}</>}
            {" · "}
            <span className="font-mono">#{item.leadId.slice(0, 6)}</span>
          </p>
        </button>

        <div className="shrink-0 flex flex-col items-end gap-0.5 text-right">
          {isResolved && item.resolutionOutcome && (
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${OUTCOME_BG[item.resolutionOutcome]}`}>
              {OUTCOME_LABEL[item.resolutionOutcome]}
            </span>
          )}
          {!isResolved && u === "red" && (
            <span className="rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
              Overdue ≥4h
            </span>
          )}
          {!isResolved && u === "yellow" && (
            <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
              Overdue ≥2h
            </span>
          )}
          {!isResolved && u === "stale" && (
            <span className="rounded-full bg-orange-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
              Stale
            </span>
          )}
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {timeAgo(item.attentionResetAt)} ago
          </span>
        </div>
      </div>

      {!isResolved && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          {item.claimedAt ? (
            <button
              onClick={() => unclaim(item.leadId)}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-200 transition-colors"
              title="Release this claim"
            >
              <UserCheck className="h-3 w-3" />
              {item.claimerName ?? "Someone"} is on it
              <X className="h-2.5 w-2.5 opacity-60 ml-0.5" />
            </button>
          ) : (
            <button
              onClick={() => claim(item.leadId)}
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 transition-colors"
            >
              <UserCheck className="h-3 w-3" />
              I&apos;ll take this
            </button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 transition-colors">
                <Check className="h-3 w-3" />
                Resolve
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem onClick={() => resolve(item.leadId, "converted")}>
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-2" />
                Converted to lead
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => resolve(item.leadId, "not_interested")}>
                <span className="inline-block w-2 h-2 rounded-full bg-slate-400 mr-2" />
                Not interested / no fit
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => resolve(item.leadId, "no_response")}>
                <span className="inline-block w-2 h-2 rounded-full bg-amber-500 mr-2" />
                Followed up — no response
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <button
            onClick={goToLead}
            className="ml-auto text-[11px] font-medium text-primary hover:underline"
          >
            Open →
          </button>
        </div>
      )}
    </div>
  );
}
