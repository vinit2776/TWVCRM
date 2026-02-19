"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { MONTH_NAMES } from "@/lib/constants";

interface ExportSummaryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  year: number;
  month: number;
}

export function ExportSummaryDialog({
  open,
  onOpenChange,
  year,
  month,
}: ExportSummaryDialogProps) {
  const [loading, setLoading] = useState(false);

  const handleExportJSON = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/accounting/monthly-summary/export?year=${year}&month=${month}`);
      if (!res.ok) {
        toast.error("Failed to export data");
        return;
      }

      const { data } = await res.json();

      // Download as JSON file
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `accounting-summary-${year}-${month.toString().padStart(2, "0")}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success("Export downloaded");
      onOpenChange(false);
    } catch {
      toast.error("Network error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Export Summary</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Export accounting summary for {MONTH_NAMES[month - 1]} {year}
          </p>

          <Button className="w-full" variant="outline" onClick={handleExportJSON} disabled={loading}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Download Summary Data
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
