"use client";

import { useState } from "react";
import { Inbox, MessageSquare } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEnquiryNotifications } from "@/providers/enquiry-notifications-provider";
import type { WhatsAppInboundItem } from "@/providers/enquiry-notifications-provider";
import { EnquiryQueueRow } from "@/components/enquiries/enquiry-queue-row";

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function WhatsAppRow({
  item,
  onClose,
}: {
  item: WhatsAppInboundItem;
  onClose: () => void;
}) {
  const router = useRouter();

  function handleClick() {
    onClose();
    if (item.leadId) router.push(`/leads/${item.leadId}`);
  }

  return (
    <button
      onClick={handleClick}
      className="w-full flex items-start gap-2 px-3 py-2 rounded-md text-left hover:bg-muted transition-colors"
    >
      <MessageSquare className="h-3.5 w-3.5 text-green-600 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">+{item.fromNumber}</p>
        <p className="text-xs text-muted-foreground truncate">{item.messagePreview || "(no text)"}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">{timeAgo(item.time)}</p>
      </div>
      {item.leadId && <span className="text-muted-foreground mt-0.5 shrink-0 text-xs">→</span>}
    </button>
  );
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const {
    totalCount, activeCount, items,
    waInboundCount, waInboundItems, markWhatsAppSeen,
  } = useEnquiryNotifications();

  function handleClose() {
    setOpen(false);
  }

  function handleOpen(val: boolean) {
    setOpen(val);
    if (val && waInboundCount > 0) markWhatsAppSeen();
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" title="Enquiry notifications">
          <Inbox className="h-4 w-4" />
          {totalCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white leading-none">
              {totalCount > 99 ? "99+" : totalCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-96 p-0" sideOffset={8}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b">
          <p className="text-sm font-semibold">Enquiry Notifications</p>
          {totalCount > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
              {totalCount}
            </span>
          )}
        </div>

        <div className="max-h-[28rem] overflow-y-auto">
          {/* Active enquiries — single list, drives both new + re-enquiry attention */}
          {items.length > 0 && (
            <div className="px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                Needs attention ({activeCount})
              </p>
              <div className="space-y-1.5">
                {items.slice(0, 8).map((item) => (
                  <EnquiryQueueRow
                    key={item.leadId}
                    item={item}
                    onNavigate={handleClose}
                    compact
                  />
                ))}
              </div>
            </div>
          )}

          {/* WhatsApp Replies section */}
          {waInboundItems.length > 0 && (
            <div className={`px-3 py-2 ${items.length > 0 ? "border-t" : ""}`}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
                <MessageSquare className="h-3 w-3 text-green-600" />
                WhatsApp Replies ({waInboundCount > 0 ? waInboundCount : waInboundItems.length})
              </p>
              <div className="space-y-0.5">
                {waInboundItems.map((item) => (
                  <WhatsAppRow key={item.id} item={item} onClose={handleClose} />
                ))}
              </div>
            </div>
          )}

          {/* Empty state */}
          {items.length === 0 && waInboundItems.length === 0 && (
            <div className="px-3 py-6 text-center">
              <Inbox className="h-8 w-8 mx-auto mb-2 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No notifications</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-t">
          <Link
            href="/leads/enquiry-log"
            onClick={handleClose}
            className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          >
            Enquiry log →
          </Link>
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
