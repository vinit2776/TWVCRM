"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { FacilityPhotoUpload, type UploadedPhoto } from "@/components/facility/photo-upload";
import { TOUR_REPORT_OUTCOMES, TOUR_REPORT_OUTCOME_LABELS, reportProblem, type TourReportOutcome } from "@/lib/tour-reports";

/**
 * The host's visit report: how it went, a comment and at least one photo. The photos upload to the
 * tour's own folder first; the report is saved only when all three are there. Nothing is sent to the
 * customer. The person who booked the tour and the accompanier are told inside the CRM.
 */
export function TourReportSheet({
  tourId,
  customer,
  accompanierName,
  open,
  onOpenChange,
  onDone,
}: {
  tourId: string;
  customer: string;
  accompanierName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [outcome, setOutcome] = useState<TourReportOutcome | null>(null);
  const [comments, setComments] = useState("");
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [busy, setBusy] = useState(false);

  const problem = reportProblem({ outcome, comments, photoPaths: photos.map((p) => p.file_path) });

  const submit = async () => {
    if (problem) return;
    setBusy(true);
    const res = await fetch(`/api/tours/${tourId}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome, comments, photos: photos.map((p) => ({ file_path: p.file_path })) }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return void toast.error(json.error ?? "Could not save the report");
    toast.success("Report saved. The tour is recorded as held.");
    setOutcome(null);
    setComments("");
    setPhotos([]);
    onOpenChange(false);
    onDone();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto p-4 sm:max-w-md">
        <SheetHeader className="pr-8">
          <SheetTitle>Visit report · {customer}</SheetTitle>
          <p className="text-sm text-muted-foreground">Nothing here is sent to the customer.</p>
        </SheetHeader>
        <div className="mt-4 space-y-4 text-sm">
          <div className="space-y-2">
            <div className="font-semibold">How did the visit go?</div>
            <div className="flex flex-wrap gap-2">
              {TOUR_REPORT_OUTCOMES.map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => setOutcome(o)}
                  className={`min-h-10 rounded-full border px-4 py-2 ${outcome === o ? "border-primary bg-primary/10 font-semibold text-primary" : "hover:bg-muted"}`}
                >
                  {TOUR_REPORT_OUTCOME_LABELS[o]}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <div className="font-semibold">Comments</div>
            <Textarea value={comments} onChange={(e) => setComments(e.target.value)} placeholder="What they liked, what worried them, what they asked for…" rows={4} />
          </div>
          <div className="space-y-2">
            <div className="font-semibold">Photos <span className="font-normal text-muted-foreground">(at least one)</span></div>
            <FacilityPhotoUpload
              pathPrefix={`tour-reports/${tourId}`}
              photos={photos}
              onUploaded={(p) => setPhotos((cur) => [...cur, p])}
              onRemove={(i) => setPhotos((cur) => cur.filter((_, idx) => idx !== i))}
              disabled={busy}
            />
          </div>
          {accompanierName && <p className="rounded-md bg-muted/40 p-2 text-muted-foreground">{accompanierName} accompanied this visit and can add their own note after you submit.</p>}
          {problem ? <p className="text-red-700">{problem}</p> : <p className="text-emerald-700">Ready to submit.</p>}
          <div className="flex gap-2">
            <Button disabled={!!problem || busy} onClick={submit}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Submit the report
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
