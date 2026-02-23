"use client";

import { useState } from "react";
import { Bell } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEnquiryNotifications } from "@/hooks/use-enquiry-notifications";
import type { EnquiryNotificationItem } from "@/hooks/use-enquiry-notifications";

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function NotificationRow({
  item,
  onClose,
}: {
  item: EnquiryNotificationItem;
  onClose: () => void;
}) {
  const router = useRouter();

  function handleClick() {
    onClose();
    router.push(`/leads/${item.leadId}`);
  }

  return (
    <button
      onClick={handleClick}
      className="w-full flex items-start justify-between gap-2 px-3 py-2 rounded-md text-left hover:bg-muted transition-colors"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{item.name}</p>
        <p className="text-xs text-muted-foreground truncate">
          {item.source} · {timeAgo(item.time)}
        </p>
      </div>
      <span className="text-muted-foreground mt-0.5 shrink-0 text-xs">→</span>
    </button>
  );
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { totalCount, newLeadCount, reEnquiryCount, recentItems, markReEnquiriesSeen } =
    useEnquiryNotifications();

  const newLeadItems = recentItems.filter((i) => i.type === "lead");
  const reEnquiryItems = recentItems.filter((i) => i.type === "activity");

  function handleClose() {
    setOpen(false);
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" title="Enquiry notifications">
          <Bell className="h-4 w-4" />
          {totalCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white leading-none">
              {totalCount > 99 ? "99+" : totalCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80 p-0" sideOffset={8}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b">
          <p className="text-sm font-semibold">Enquiry Notifications</p>
          {totalCount > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
              {totalCount}
            </span>
          )}
        </div>

        <div className="max-h-96 overflow-y-auto">
          {/* New Enquiries section */}
          {newLeadItems.length > 0 && (
            <div className="px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                New Enquiries ({newLeadCount})
              </p>
              <div className="space-y-0.5">
                {newLeadItems.map((item) => (
                  <NotificationRow key={item.leadId + "-lead"} item={item} onClose={handleClose} />
                ))}
              </div>
            </div>
          )}

          {/* Re-Enquiries section */}
          {reEnquiryItems.length > 0 && (
            <div className={`px-3 py-2 ${newLeadItems.length > 0 ? "border-t" : ""}`}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Re-Enquiries ({reEnquiryCount})
              </p>
              <div className="space-y-0.5">
                {reEnquiryItems.map((item, idx) => (
                  <NotificationRow
                    key={item.leadId + "-activity-" + idx}
                    item={item}
                    onClose={handleClose}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Empty state */}
          {recentItems.length === 0 && (
            <div className="px-3 py-6 text-center">
              <Bell className="h-8 w-8 mx-auto mb-2 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No enquiries yet</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-t">
          {reEnquiryCount > 0 ? (
            <button
              onClick={markReEnquiriesSeen}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors underline-offset-2 hover:underline"
            >
              Mark re-enquiries seen
            </button>
          ) : (
            <span />
          )}
          <Link
            href="/leads?status=new"
            onClick={handleClose}
            className="text-xs font-medium text-primary hover:underline underline-offset-2"
          >
            All Leads →
          </Link>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
