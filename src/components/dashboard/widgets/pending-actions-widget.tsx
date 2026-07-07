"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { ClipboardCheck, ShieldAlert, FileText, Package, Zap, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { PendingActionItem } from "@/app/api/dashboard/pending-actions/route";

const MODULE_ICONS: Record<string, React.ReactNode> = {
  "Deposit Waiver": <ShieldAlert className="h-4 w-4 text-amber-600" />,
  "Vendor Bills": <FileText className="h-4 w-4 text-blue-600" />,
  "Material Requests": <Package className="h-4 w-4 text-purple-600" />,
  "Electricity Bills": <Zap className="h-4 w-4 text-orange-600" />,
};

const MODULE_COLORS: Record<string, string> = {
  "Deposit Waiver": "bg-amber-100 text-amber-800 border-amber-200",
  "Vendor Bills": "bg-blue-100 text-blue-800 border-blue-200",
  "Material Requests": "bg-purple-100 text-purple-800 border-purple-200",
  "Electricity Bills": "bg-orange-100 text-orange-800 border-orange-200",
};

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  const days = Math.floor(diff / 86400);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

export function PendingActionsWidget() {
  const [items, setItems] = useState<PendingActionItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard/pending-actions")
      .then((r) => r.json())
      .then((json) => setItems(json.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <ClipboardCheck className="h-5 w-5 text-primary" />
          <span className="text-base font-semibold">Pending Actions</span>
        </div>
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 rounded-md bg-muted/50 animate-pulse" />
          ))}
        </div>
      </Card>
    );
  }

  if (items.length === 0) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <ClipboardCheck className="h-5 w-5 text-green-600" />
          <span className="text-base font-semibold">Pending Actions</span>
        </div>
        <p className="text-sm text-muted-foreground">No pending approvals — you&apos;re all caught up!</p>
      </Card>
    );
  }

  // Group by module
  const grouped = items.reduce<Record<string, PendingActionItem[]>>((acc, item) => {
    if (!acc[item.module]) acc[item.module] = [];
    acc[item.module].push(item);
    return acc;
  }, {});

  return (
    <Card className="border-2 border-amber-300 bg-amber-50/30">
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-amber-700" />
            <span className="text-base font-semibold text-amber-900">Pending Actions</span>
            <Badge variant="secondary" className="bg-amber-200 text-amber-800 text-xs font-bold">
              {items.length}
            </Badge>
          </div>
        </div>

        <div className="space-y-4">
          {Object.entries(grouped).map(([module, moduleItems]) => (
            <div key={module}>
              <div className="flex items-center gap-1.5 mb-2">
                {MODULE_ICONS[module] || <ClipboardCheck className="h-3.5 w-3.5" />}
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {module} ({moduleItems.length})
                </span>
              </div>
              <div className="space-y-1.5">
                {moduleItems.map((item) => (
                  <Link
                    key={item.id}
                    href={item.link}
                    className="flex items-center justify-between rounded-md px-3 py-2.5 bg-white hover:bg-amber-50 transition-colors border border-amber-100 group"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate group-hover:text-amber-800 transition-colors">
                          {item.title}
                        </p>
                        <Badge
                          variant="outline"
                          className={`text-[10px] shrink-0 ${MODULE_COLORS[item.module] || ""}`}
                        >
                          {module}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {item.subtitle} · {timeAgo(item.created_at)}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-amber-600 transition-colors shrink-0 ml-2" />
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
