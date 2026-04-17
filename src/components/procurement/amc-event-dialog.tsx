"use client";

import { useState, useRef } from "react";
import { Loader2, Paperclip, X, FileText, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { AmcEventType } from "@/types";

const EVENT_TYPE_LABELS: Record<AmcEventType, string> = {
  breakdown:       "Breakdown / Emergency Call",
  preventive:      "Preventive Maintenance Visit",
  remote_support:  "Remote / Phone Support",
  annual_service:  "Annual Full Service",
};

const ACCEPTED_FILE_TYPES = ["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_FILE_SIZE = 10 * 1024 * 1024;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  poId: string;
  eventNumber: number;         // next event number (for the dialog title)
  visitsCovered: number | null;// null = unlimited
  visitsUsed: number;
  onSuccess: () => void;
}

export function AmcEventDialog({
  open, onOpenChange, poId, eventNumber, visitsCovered, visitsUsed, onSuccess
}: Props) {
  const [eventType, setEventType] = useState<AmcEventType>("breakdown");
  const [eventDate, setEventDate] = useState(new Date().toISOString().split("T")[0]);
  const [technicianName, setTechnicianName] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [nextScheduledDate, setNextScheduledDate] = useState("");
  const [reportFile, setReportFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const atLimit = visitsCovered !== null && visitsUsed >= visitsCovered;

  function reset() {
    setEventType("breakdown");
    setEventDate(new Date().toISOString().split("T")[0]);
    setTechnicianName("");
    setIssueDescription("");
    setResolutionNotes("");
    setNextScheduledDate("");
    setReportFile(null);
  }

  async function handleSubmit() {
    if (!issueDescription.trim()) {
      toast.error("Please describe the issue or work done");
      return;
    }

    setUploading(true);
    try {
      let reportFileUrl: string | undefined;

      if (reportFile) {
        const supabase = createClient();
        const ext = reportFile.name.split(".").pop() ?? "pdf";
        const filePath = `amc-reports/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const { error: uploadErr } = await supabase.storage
          .from("procurement-docs")
          .upload(filePath, reportFile);
        if (uploadErr) throw new Error(uploadErr.message);
        const { data: urlData } = supabase.storage
          .from("procurement-docs")
          .getPublicUrl(filePath);
        reportFileUrl = urlData.publicUrl;
      }

      const res = await fetch(`/api/procurement/amc/${poId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: eventType,
          event_date: eventDate,
          technician_name: technicianName || undefined,
          issue_description: issueDescription,
          resolution_notes: resolutionNotes || undefined,
          next_scheduled_date: nextScheduledDate || undefined,
          report_file_url: reportFileUrl,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Failed to log event");

      toast.success(`Service event #${eventNumber} logged successfully`);

      if (data.at_limit) {
        toast.warning(
          `AMC visit limit reached (${data.visits_used}/${data.visits_covered}). Verify contract scope before logging further events.`,
          { duration: 8000 }
        );
      }

      reset();
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to log event");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!uploading) { onOpenChange(o); if (!o) reset(); } }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Log Service Event #{eventNumber}</DialogTitle>
        </DialogHeader>

        {/* Visit limit warning */}
        {atLimit && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-amber-600" />
            <span>
              Visit limit reached ({visitsUsed}/{visitsCovered}). Logging this event will exceed the contracted coverage.
              Please verify with the vendor before proceeding.
            </span>
          </div>
        )}

        {/* Visit count info */}
        {!atLimit && visitsCovered !== null && (
          <div className="text-xs text-muted-foreground bg-muted/40 rounded-md px-3 py-2">
            {visitsUsed} of {visitsCovered} visits used · {visitsCovered - visitsUsed} remaining after this event
          </div>
        )}

        <div className="space-y-4">
          {/* Event type */}
          <div className="space-y-1.5">
            <Label>Event Type *</Label>
            <Select value={eventType} onValueChange={(v) => setEventType(v as AmcEventType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.entries(EVENT_TYPE_LABELS) as [AmcEventType, string][]).map(([val, label]) => (
                  <SelectItem key={val} value={val}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Date + Technician */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Event Date *</Label>
              <Input
                type="date"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Technician Name</Label>
              <Input
                placeholder="Who attended?"
                value={technicianName}
                onChange={(e) => setTechnicianName(e.target.value)}
              />
            </div>
          </div>

          {/* Issue description */}
          <div className="space-y-1.5">
            <Label>Issue / Work Done *</Label>
            <Textarea
              placeholder="Describe the problem reported or maintenance work performed..."
              value={issueDescription}
              onChange={(e) => setIssueDescription(e.target.value)}
              rows={3}
            />
          </div>

          {/* Resolution */}
          <div className="space-y-1.5">
            <Label>Resolution / Outcome</Label>
            <Textarea
              placeholder="What was done to resolve the issue? Parts replaced, settings changed, etc."
              value={resolutionNotes}
              onChange={(e) => setResolutionNotes(e.target.value)}
              rows={2}
            />
          </div>

          {/* Next visit + file */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Next Scheduled Visit</Label>
              <Input
                type="date"
                value={nextScheduledDate}
                onChange={(e) => setNextScheduledDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Job Card / Report</Label>
              {reportFile ? (
                <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                  <FileText className="h-4 w-4 text-primary flex-shrink-0" />
                  <span className="text-xs flex-1 truncate">{reportFile.name}</span>
                  <button type="button" onClick={() => setReportFile(null)}>
                    <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                  </button>
                </div>
              ) : (
                <div
                  className="flex items-center justify-center rounded-md border-2 border-dashed border-muted-foreground/25 px-3 py-2 cursor-pointer hover:border-muted-foreground/50 transition-colors"
                  onClick={() => fileRef.current?.click()}
                >
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Paperclip className="h-4 w-4" />
                    <span>Attach file</span>
                  </div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png,.webp"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      if (!ACCEPTED_FILE_TYPES.includes(f.type)) {
                        toast.error("Only PDF, JPEG, PNG, or WebP files are accepted");
                        return;
                      }
                      if (f.size > MAX_FILE_SIZE) {
                        toast.error("File size must be under 10 MB");
                        return;
                      }
                      setReportFile(f);
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={uploading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={uploading || !issueDescription.trim()}>
            {uploading && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Log Event #{eventNumber}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
