"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LogOut, X, Loader2 } from "lucide-react";
import { toast } from "sonner";

export function BulkActionsBar({
  selectedIds,
  onClear,
  onActionComplete,
}: {
  selectedIds: string[];
  onClear: () => void;
  onActionComplete: () => void;
}) {
  const [loading, setLoading] = useState(false);

  if (selectedIds.length === 0) return null;

  const performBulkAction = async (action: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/bookings/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, booking_ids: selectedIds }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Bulk action failed");
        return;
      }
      toast.success(json.message);
      onClear();
      onActionComplete();
    } catch {
      toast.error("Bulk action failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-white border shadow-lg rounded-xl px-4 py-3 flex items-center gap-3">
      <span className="text-sm font-medium text-gray-700">
        {selectedIds.length} selected
      </span>
      <div className="h-4 w-px bg-gray-200" />
      <Button
        size="sm"
        variant="outline"
        onClick={() => performBulkAction("checkout")}
        disabled={loading}
        className="text-green-700 border-green-200 hover:bg-green-50"
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4 mr-1" />}
        Bulk Check-out
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => performBulkAction("cancel")}
        disabled={loading}
        className="text-red-700 border-red-200 hover:bg-red-50"
      >
        <X className="w-4 h-4 mr-1" />
        Bulk Cancel
      </Button>
      <Button size="sm" variant="ghost" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
