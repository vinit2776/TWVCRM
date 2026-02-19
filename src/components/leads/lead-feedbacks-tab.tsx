"use client";

import { useState, useEffect, useCallback } from "react";
import { Star } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { FEEDBACK_DIMENSIONS } from "@/lib/constants";
import { formatDate } from "@/lib/utils";
import type { BookingFeedback } from "@/types";

interface LeadFeedbacksTabProps {
  leadId: string;
}

function RatingStars({ value }: { value: number | null }) {
  if (value == null) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          className={`h-3 w-3 ${
            s <= value
              ? "fill-amber-400 text-amber-400"
              : "fill-none text-gray-300"
          }`}
        />
      ))}
    </div>
  );
}

function OverallBadge({ rating }: { rating: number | null }) {
  if (rating == null) return <span className="text-xs text-muted-foreground">—</span>;
  const color =
    rating >= 4
      ? "bg-green-100 text-green-800"
      : rating >= 3
        ? "bg-amber-100 text-amber-800"
        : "bg-red-100 text-red-800";
  return (
    <Badge variant="secondary" className={color}>
      {rating.toFixed(1)} / 5
    </Badge>
  );
}

export function LeadFeedbacksTab({ leadId }: LeadFeedbacksTabProps) {
  const [feedbacks, setFeedbacks] = useState<BookingFeedback[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/leads/${leadId}/feedbacks`);
    if (res.ok) {
      const json = await res.json();
      setFeedbacks(json.data || []);
    }
    setLoading(false);
  }, [leadId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return <TableSkeleton rows={4} />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Feedback History</CardTitle>
      </CardHeader>
      <CardContent>
        {feedbacks.length === 0 ? (
          <EmptyState
            icon={Star}
            title="No feedback yet"
            description="Feedback will appear here after booking checkouts."
          />
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">Booking</th>
                  <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Date</th>
                  <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Space</th>
                  <th className="px-4 py-3 text-left font-medium">Overall</th>
                  {FEEDBACK_DIMENSIONS.map((dim) => (
                    <th
                      key={dim.key}
                      className="px-3 py-3 text-left font-medium hidden xl:table-cell"
                      title={dim.description}
                    >
                      {dim.label.split(" ")[0]}
                    </th>
                  ))}
                  <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Rated By</th>
                </tr>
              </thead>
              <tbody>
                {feedbacks.map((fb) => (
                  <tr key={fb.id} className="border-b hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs">
                      {fb.booking?.booking_number || "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                      {fb.booking?.booking_date
                        ? formatDate(fb.booking.booking_date)
                        : "—"}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      {fb.booking?.space?.name || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <OverallBadge rating={fb.overall_rating} />
                    </td>
                    {FEEDBACK_DIMENSIONS.map((dim) => (
                      <td key={dim.key} className="px-3 py-3 hidden xl:table-cell">
                        <RatingStars
                          value={fb[dim.key as keyof BookingFeedback] as number | null}
                        />
                      </td>
                    ))}
                    <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                      {fb.rater?.full_name || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Notes section below the table */}
        {feedbacks.some((fb) => fb.notes) && (
          <div className="mt-4 space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground">Notes</h4>
            {feedbacks
              .filter((fb) => fb.notes)
              .map((fb) => (
                <div key={fb.id} className="text-sm border-l-2 border-muted pl-3">
                  <span className="font-mono text-xs text-muted-foreground">
                    {fb.booking?.booking_number}
                  </span>
                  <p className="mt-0.5 whitespace-pre-wrap">{fb.notes}</p>
                </div>
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
