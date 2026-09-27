"use client";

import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Check, LinkIcon, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { FacilityPhotoUpload, type UploadedPhoto } from "@/components/facility/photo-upload";
import type { FacilityAssetEventType } from "@/types";

const EVENT_TYPES: { value: FacilityAssetEventType; label: string; icon: string }[] = [
  { value: "maintenance", label: "Maintenance done", icon: "🔧" },
  { value: "inspection", label: "Inspection", icon: "🔍" },
  { value: "fault_observed", label: "Fault observed", icon: "⚠️" },
  { value: "part_replaced", label: "Part replaced", icon: "🔄" },
  { value: "cleaning", label: "Cleaning", icon: "🧹" },
  { value: "installation", label: "Installation", icon: "📦" },
  { value: "relocation", label: "Relocation", icon: "📍" },
  { value: "other", label: "Other", icon: "📝" },
];

export interface OpenIssue {
  id: string;
  issue_number: string;
  title: string;
  status: string;
  priority: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: string;
  assetName: string;
  assetCode: string;
  attentionNotes?: string | null;
  openIssues?: OpenIssue[];
  onCreated?: () => void;
}

export function AssetEventDialog({ open, onOpenChange, assetId, assetName, assetCode, attentionNotes, openIssues = [], onCreated }: Props) {
  const [eventType, setEventType] = useState<FacilityAssetEventType>("maintenance");
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [resolveIssue, setResolveIssue] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setEventType("maintenance");
    setNote("");
    setPhotos([]);
    setSelectedIssueId(null);
    setResolveIssue(true);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/facility/assets/${assetId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: eventType,
          note: note.trim() || null,
          photo_urls: photos.map((p) => p.file_url),
          issue_id: selectedIssueId,
          resolve_issue: selectedIssueId ? resolveIssue : false,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to log event");

      if (json.resolve_error) {
        // The event saved but the ticket did not move — say so, rather than
        // reporting a resolve that never happened.
        toast.warning(`Event logged, but the ticket wasn't resolved: ${json.resolve_error}`);
      } else {
        toast.success(selectedIssueId && resolveIssue ? "Event logged & issue resolved" : "Event logged");
      }
      onOpenChange(false);
      reset();
      onCreated?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to log event");
    } finally {
      setSubmitting(false);
    }
  };

  const activeIssues = openIssues.filter((i) =>
    ["new", "acknowledged", "in_progress", "reopened"].includes(i.status)
  );

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Log Event</DialogTitle>
          <DialogDescription className="text-xs">
            <code className="font-mono">{assetCode}</code> · {assetName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {attentionNotes && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-[11px] font-semibold text-amber-800 uppercase tracking-wide mb-0.5">Attention — check on this visit</p>
                <p className="text-sm text-amber-900">{attentionNotes}</p>
              </div>
            </div>
          )}

          <div>
            <div className="text-sm font-medium mb-2">What happened?</div>
            <div className="grid grid-cols-2 gap-1.5">
              {EVENT_TYPES.map((t) => {
                const sel = eventType === t.value;
                return (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setEventType(t.value)}
                    className={cn(
                      "flex items-center gap-2 px-3 py-2 rounded-lg border text-left text-sm transition",
                      sel ? "border-[#015E65] bg-[#015E65]/5 font-medium" : "border-border hover:bg-muted/40",
                    )}
                  >
                    {sel ? <Check className="h-3.5 w-3.5 text-[#015E65] shrink-0" /> : <span className="text-sm shrink-0">{t.icon}</span>}
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          {activeIssues.length > 0 && (
            <div>
              <div className="text-sm font-medium mb-1.5 flex items-center gap-1.5">
                <LinkIcon className="h-3.5 w-3.5" />
                Link to issue (optional)
              </div>
              <div className="space-y-1">
                {activeIssues.map((issue) => {
                  const sel = selectedIssueId === issue.id;
                  return (
                    <button
                      key={issue.id}
                      type="button"
                      onClick={() => setSelectedIssueId(sel ? null : issue.id)}
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-left text-sm transition",
                        sel ? "border-[#015E65] bg-[#015E65]/5" : "border-border hover:bg-muted/40",
                      )}
                    >
                      {sel && <Check className="h-3.5 w-3.5 text-[#015E65] shrink-0" />}
                      <code className="text-xs text-muted-foreground font-mono">{issue.issue_number}</code>
                      <span className="truncate">{issue.title}</span>
                    </button>
                  );
                })}
              </div>
              {selectedIssueId && (
                <label className="flex items-center gap-2 mt-2 text-sm cursor-pointer">
                  <Checkbox
                    checked={resolveIssue}
                    onCheckedChange={(v) => setResolveIssue(v === true)}
                  />
                  Mark issue as resolved
                </label>
              )}
            </div>
          )}

          <div>
            <div className="text-sm font-medium mb-1">Note</div>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What was done? What did you observe?"
              rows={3}
              maxLength={2000}
            />
          </div>

          <div>
            <div className="text-sm font-medium mb-1">Photo (optional)</div>
            <FacilityPhotoUpload
              pathPrefix="asset-event"
              photos={photos}
              onUploaded={(p) => setPhotos((prev) => [...prev, p])}
              onRemove={(i) => setPhotos((prev) => prev.filter((_, idx) => idx !== i))}
              disabled={submitting}
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={submitting}>
              {submitting ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Saving…</> : "Log Event"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
