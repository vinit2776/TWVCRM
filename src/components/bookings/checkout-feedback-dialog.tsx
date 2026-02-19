"use client";

import { useState } from "react";
import { Star, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FEEDBACK_DIMENSIONS } from "@/lib/constants";
import { toast } from "sonner";

interface CheckoutFeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookingId: string;
  bookingNumber: string;
  customerName: string;
  onSuccess: () => void;
}

function StarRating({
  value,
  onChange,
}: {
  value: number;
  onChange: (val: number) => void;
}) {
  const [hover, setHover] = useState(0);

  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          className="p-0.5 transition-colors"
          onClick={() => onChange(star === value ? 0 : star)}
          onMouseEnter={() => setHover(star)}
          onMouseLeave={() => setHover(0)}
        >
          <Star
            className={`h-5 w-5 ${
              star <= (hover || value)
                ? "fill-amber-400 text-amber-400"
                : "fill-none text-gray-300"
            }`}
          />
        </button>
      ))}
    </div>
  );
}

export function CheckoutFeedbackDialog({
  open,
  onOpenChange,
  bookingId,
  bookingNumber,
  customerName,
  onSuccess,
}: CheckoutFeedbackDialogProps) {
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const setDimensionRating = (key: string, value: number) => {
    setRatings((prev) => {
      const next = { ...prev };
      if (value === 0) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };

  const ratedCount = Object.keys(ratings).length;

  const handleSubmit = async () => {
    if (ratedCount === 0) {
      toast.error("Please rate at least one dimension");
      return;
    }

    setSubmitting(true);
    const body: Record<string, unknown> = { ...ratings };
    if (notes.trim()) body.notes = notes.trim();

    const res = await fetch(`/api/bookings/${bookingId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      toast.success("Feedback submitted successfully");
      resetForm();
      onOpenChange(false);
      onSuccess();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to submit feedback");
    }
    setSubmitting(false);
  };

  const resetForm = () => {
    setRatings({});
    setNotes("");
  };

  const handleSkip = () => {
    resetForm();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Star className="h-5 w-5 text-amber-500" />
            Rate Customer Experience
          </DialogTitle>
          <DialogDescription>
            {bookingNumber} &middot; {customerName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Rating dimensions */}
          {FEEDBACK_DIMENSIONS.map((dim) => (
            <div
              key={dim.key}
              className="flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{dim.label}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {dim.description}
                </p>
              </div>
              <StarRating
                value={ratings[dim.key] || 0}
                onChange={(val) => setDimensionRating(dim.key, val)}
              />
            </div>
          ))}

          {/* Notes */}
          <div className="space-y-2 pt-2 border-t">
            <Label htmlFor="feedback-notes">Notes (optional)</Label>
            <Textarea
              id="feedback-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any additional observations about this customer..."
              rows={3}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleSkip}>
            Skip
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || ratedCount === 0}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Submit Feedback
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
