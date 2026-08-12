"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { preventEnterSubmit } from "@/lib/utils";
import { prepareUpload, UploadTooLargeError } from "@/lib/uploads/upload-gate";
import { Loader2, Upload, X, Image as ImageIcon } from "lucide-react";
import {
  TICKET_TYPES,
  TICKET_TYPE_LABELS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
} from "@/lib/constants";

interface ReportIssueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReportIssueDialog({
  open,
  onOpenChange,
}: ReportIssueDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<string>("bug");
  const [priority, setPriority] = useState<string>("medium");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null);

  // Auto-captured context
  const [pageUrl, setPageUrl] = useState("");
  const [userAgent, setUserAgent] = useState("");
  const [screenResolution, setScreenResolution] = useState("");

  // Capture context when dialog opens
  useEffect(() => {
    if (open) {
      setPageUrl(window.location.href);
      setUserAgent(navigator.userAgent);
      setScreenResolution(`${window.innerWidth}x${window.innerHeight}`);
    }
  }, [open]);

  function resetForm() {
    setSubject("");
    setDescription("");
    setType("bug");
    setPriority("medium");
    setScreenshot(null);
    setScreenshotPreview(null);
  }

  function handleScreenshotChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast.error("Only image files are allowed");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error("File size must be under 10MB");
      return;
    }

    setScreenshot(file);
    const reader = new FileReader();
    reader.onload = () => setScreenshotPreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  function removeScreenshot() {
    setScreenshot(null);
    setScreenshotPreview(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!subject.trim()) {
      toast.error("Subject is required");
      return;
    }

    setSubmitting(true);
    try {
      // Step 1: Create the ticket
      const res = await fetch("/api/support-tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: subject.trim(),
          description: description.trim() || undefined,
          type,
          priority,
          page_url: pageUrl,
          user_agent: userAgent,
          screen_resolution: screenResolution,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to submit ticket");
      }

      const { data: ticket } = await res.json();

      // Step 2: Upload screenshot if present — normalize client-side first.
      if (screenshot && ticket.id) {
        let processed: File | null = null;
        try {
          processed = await prepareUpload(screenshot);
        } catch (e) {
          if (e instanceof UploadTooLargeError) toast.error(e.message);
          else toast.error(e instanceof Error ? e.message : "Screenshot too large");
        }

        const formData = new FormData();
        formData.append("file", processed ?? screenshot);

        const uploadRes = processed
          ? await fetch(`/api/support-tickets/${ticket.id}/screenshot`, { method: "POST", body: formData })
          : null;

        if (!uploadRes || !uploadRes.ok) {
          // Ticket was created but screenshot failed — still show success
          toast.warning(
            `Ticket ${ticket.ticket_number} created but screenshot upload failed`
          );
          resetForm();
          onOpenChange(false);
          return;
        }
      }

      toast.success(`Ticket ${ticket.ticket_number} submitted successfully`);
      resetForm();
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to submit ticket"
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Report an Issue</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="space-y-4">
          {/* Subject */}
          <div className="space-y-2">
            <Label htmlFor="ticket-subject">
              Subject <span className="text-destructive">*</span>
            </Label>
            <Input
              id="ticket-subject"
              placeholder="Briefly describe the issue..."
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
              autoFocus
            />
          </div>

          {/* Type & Priority */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TICKET_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {TICKET_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TASK_PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {TASK_PRIORITY_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="ticket-description">Description</Label>
            <Textarea
              id="ticket-description"
              placeholder="Provide more details about the issue, what you expected, and what happened instead..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
            />
          </div>

          {/* Screenshot */}
          <div className="space-y-2">
            <Label>Screenshot (optional)</Label>
            {screenshotPreview ? (
              <div className="relative rounded-md border overflow-hidden">
                <img
                  src={screenshotPreview}
                  alt="Screenshot preview"
                  className="w-full max-h-48 object-contain bg-muted"
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="absolute top-2 right-2 h-6 w-6"
                  onClick={removeScreenshot}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground hover:bg-muted/50 transition-colors">
                <ImageIcon className="h-4 w-4" />
                <span>Click to attach a screenshot</span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleScreenshotChange}
                />
              </label>
            )}
          </div>

          {/* Auto-captured context (read-only info) */}
          <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground text-xs">Auto-captured context:</p>
            <p className="truncate">Page: {pageUrl}</p>
            <p>Resolution: {screenResolution}</p>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Submit Ticket
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
