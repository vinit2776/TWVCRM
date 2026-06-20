"use client";

import { useRouter } from "next/navigation";
import { RefreshCw, X } from "lucide-react";
import { useEnquiryNotifications } from "@/providers/enquiry-notifications-provider";
import type { EnquiryNotificationItem } from "@/hooks/use-enquiry-notifications";

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

interface Props {
  item: EnquiryNotificationItem;
  onNavigate?: () => void;
}

export function EnquiryQueueRow({ item, onNavigate }: Props) {
  const router = useRouter();
  const { dismissReEnquiryItem } = useEnquiryNotifications();

  function goToLead() {
    onNavigate?.();
    if (item.type === "activity") dismissReEnquiryItem(item.leadId);
    router.push(`/leads/${item.leadId}`);
  }

  return (
    <div className={`rounded-lg border px-3 py-2.5 flex items-start justify-between gap-2 transition-colors
      ${item.type === "activity"
        ? "border-amber-300 bg-amber-50/40"
        : "border-emerald-300 bg-emerald-50/40"
      }`}
    >
      <button onClick={goToLead} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-medium truncate">{item.name}</span>
          {item.type === "activity" && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
              <RefreshCw className="h-2.5 w-2.5" />
              Re-enquiry
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate mt-0.5">
          {item.source} · <span className="font-mono">#{item.leadId.slice(0, 6)}</span> · {timeAgo(item.time)} ago
        </p>
      </button>
      {item.type === "activity" && (
        <button
          onClick={(e) => { e.stopPropagation(); dismissReEnquiryItem(item.leadId); }}
          className="shrink-0 text-muted-foreground hover:text-foreground mt-0.5"
          title="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
