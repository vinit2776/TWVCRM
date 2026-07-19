"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  FollowUpDateTimeInput,
  type FollowUpDateTimeStatus,
} from "@/components/shared/followup-datetime-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ACTIVITY_TYPES,
  ACTIVITY_TYPE_LABELS,
  CALL_OUTCOMES,
  CALL_OUTCOME_LABELS,
} from "@/lib/constants";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import type { ActivityType } from "@/types";

interface ActivityFormProps {
  leadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  defaultType?: ActivityType;
}

export function ActivityForm({
  leadId,
  open,
  onOpenChange,
  onSuccess,
  defaultType = "call",
}: ActivityFormProps) {
  const [type, setType] = useState<ActivityType>(defaultType);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [callOutcome, setCallOutcome] = useState("");
  const [callDurationMinutes, setCallDurationMinutes] = useState("");
  const [meetingLocation, setMeetingLocation] = useState("");
  const [meetingStart, setMeetingStart] = useState("");
  const [meetingEnd, setMeetingEnd] = useState("");
  const [followUpDate, setFollowUpDate] = useState("");
  const [followUpStatus, setFollowUpStatus] = useState<FollowUpDateTimeStatus>("empty");
  const [followUpNotes, setFollowUpNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Sync type when dialog opens — useState only captures the initial prop value,
  // so without this, reopening with a different defaultType (e.g. "meeting" after
  // a previous "call") would show the stale type from last open.
  useEffect(() => {
    if (open) {
      setType(defaultType);
    }
  }, [open, defaultType]);

  const resetForm = () => {
    setType(defaultType);
    setSubject("");
    setDescription("");
    setCallOutcome("");
    setCallDurationMinutes("");
    setMeetingLocation("");
    setMeetingStart("");
    setMeetingEnd("");
    setFollowUpDate("");
    setFollowUpStatus("empty");
    setFollowUpNotes("");
  };

  // Preview of what logging this activity will actually do — shown just above the
  // submit button so the user isn't guessing whether the follow-up "took".
  const followUpPreview =
    followUpStatus === "valid" && followUpDate
      ? format(new Date(followUpDate), "EEE, MMM d 'at' h:mm a")
      : null;

  const summaryLines: string[] = [
    `Logged: ${ACTIVITY_TYPE_LABELS[type]}${subject ? ` — "${subject}"` : ""}`,
  ];
  if (type === "call" && callOutcome) {
    summaryLines.push(`Outcome: ${CALL_OUTCOME_LABELS[callOutcome]}`);
  }
  if (followUpPreview) {
    summaryLines.push(
      `Follow-up: ${followUpPreview}${followUpNotes ? ` — "${followUpNotes}"` : ""}`,
      "Reminders: WhatsApp ~10 min before · daily 9 AM email until closed"
    );
  } else {
    summaryLines.push("No follow-up scheduled");
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (followUpStatus === "incomplete") return;
    setSubmitting(true);

    const durationSeconds = callDurationMinutes
      ? Math.round(parseFloat(callDurationMinutes) * 60)
      : undefined;

    const body: Record<string, unknown> = {
      type,
      subject: subject || undefined,
      description: description || undefined,
      call_duration_seconds: durationSeconds,
      call_outcome: callOutcome || undefined,
      meeting_location: meetingLocation || undefined,
      meeting_start_at: meetingStart || undefined,
      meeting_end_at: meetingEnd || undefined,
      follow_up_date: followUpDate || undefined,
      follow_up_notes: followUpNotes || undefined,
    };

    const res = await fetch(`/api/leads/${leadId}/activities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setSubmitting(false);
    if (res.ok) {
      toast.success("Activity logged successfully");
      resetForm();
      onOpenChange(false);
      onSuccess();
    } else {
      toast.error("Failed to log activity");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Log Activity</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Activity Type</Label>
            <Select
              value={type}
              onValueChange={(val) => setType(val as ActivityType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTIVITY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {ACTIVITY_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Subject</Label>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Brief subject..."
            />
          </div>

          {/* Call-specific fields */}
          {type === "call" && (
            <>
              <div className="space-y-2">
                <Label>Call Outcome</Label>
                <Select value={callOutcome} onValueChange={setCallOutcome}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select outcome" />
                  </SelectTrigger>
                  <SelectContent>
                    {CALL_OUTCOMES.map((o) => (
                      <SelectItem key={o} value={o}>
                        {CALL_OUTCOME_LABELS[o]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Duration (minutes)</Label>
                <Input
                  type="number"
                  step="0.5"
                  min="0"
                  value={callDurationMinutes}
                  onChange={(e) => setCallDurationMinutes(e.target.value)}
                  placeholder="e.g. 5"
                />
              </div>
            </>
          )}

          {/* Meeting-specific fields */}
          {(type === "meeting" || type === "tour") && (
            <>
              <div className="space-y-2">
                <Label>Location</Label>
                <Input
                  value={meetingLocation}
                  onChange={(e) => setMeetingLocation(e.target.value)}
                  placeholder="Meeting location..."
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Start Time</Label>
                  <Input
                    type="datetime-local"
                    value={meetingStart}
                    onChange={(e) => setMeetingStart(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>End Time</Label>
                  <Input
                    type="datetime-local"
                    value={meetingEnd}
                    onChange={(e) => setMeetingEnd(e.target.value)}
                  />
                </div>
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add notes about this activity..."
              rows={3}
            />
          </div>

          {/* Follow-up */}
          <div className="border-t pt-4 space-y-4">
            <h4 className="text-sm font-medium">Follow-up (optional)</h4>
            <div className="space-y-2">
              <Label>Follow-up Date &amp; Time</Label>
              <FollowUpDateTimeInput
                value={followUpDate}
                onChange={setFollowUpDate}
                onStatusChange={setFollowUpStatus}
              />
              {followUpStatus === "incomplete" && (
                <p className="text-xs text-destructive">
                  Pick both a date and a time between 9:00 AM and 8:00 PM.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Follow-up Notes</Label>
              <Input
                value={followUpNotes}
                onChange={(e) => setFollowUpNotes(e.target.value)}
                placeholder="Reminder..."
              />
            </div>
          </div>

          <div className="rounded-md border bg-muted/40 px-3 py-2.5">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              What happens when you log this
            </p>
            <ul className="space-y-0.5 text-sm text-foreground">
              {summaryLines.map((line, i) => (
                <li key={i} className="flex gap-1.5">
                  <span className="text-muted-foreground">•</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || followUpStatus === "incomplete"}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Log Activity
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
