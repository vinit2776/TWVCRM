"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { User, CalendarDays, IndianRupee, Star, TrendingUp } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

interface CustomerHistory {
  name: string;
  company?: string;
  phone?: string;
  email?: string;
  lead_id?: string;
  total_bookings: number;
  last_visit?: string;
  preferred_room?: string;
  total_spent: number;
  avg_spent: number;
  avg_feedback?: number | null;
  segment: string;
}

const SEGMENT_COLORS: Record<string, string> = {
  frequent: "bg-green-100 text-green-800",
  lapsed: "bg-red-100 text-red-800",
  high_spender: "bg-purple-100 text-purple-800",
  low_feedback: "bg-orange-100 text-orange-800",
  regular: "bg-blue-100 text-blue-800",
  new: "bg-gray-100 text-gray-800",
};

const SEGMENT_LABELS: Record<string, string> = {
  frequent: "Frequent",
  lapsed: "Lapsed",
  high_spender: "High Spender",
  low_feedback: "Low Feedback",
  regular: "Regular",
  new: "New Customer",
};

export function CustomerHistoryCard({ phone, leadId }: { phone?: string; leadId?: string }) {
  const [history, setHistory] = useState<CustomerHistory | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!phone && !leadId) return;
    setLoading(true);
    const params = new URLSearchParams();
    if (leadId) params.set("lead_id", leadId);
    else if (phone) params.set("phone", phone);

    fetch(`/api/bookings/customer-history?${params}`)
      .then(r => r.json())
      .then(json => { if (json.data) setHistory(json.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [phone, leadId]);

  if (loading) return <Card className="animate-pulse"><CardContent className="p-4 h-24" /></Card>;
  if (!history || history.total_bookings === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <User className="w-4 h-4" /> Customer History
          <Badge className={SEGMENT_COLORS[history.segment] || "bg-gray-100"}>
            {SEGMENT_LABELS[history.segment] || history.segment}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-gray-400" />
            <div>
              <div className="font-semibold">{history.total_bookings}</div>
              <div className="text-xs text-gray-500">Total Bookings</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <IndianRupee className="w-4 h-4 text-gray-400" />
            <div>
              <div className="font-semibold">{formatCurrency(history.total_spent)}</div>
              <div className="text-xs text-gray-500">Total Spent</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Star className="w-4 h-4 text-gray-400" />
            <div>
              <div className="font-semibold">{history.avg_feedback ? `${history.avg_feedback.toFixed(1)}/5` : "N/A"}</div>
              <div className="text-xs text-gray-500">Avg Rating</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-gray-400" />
            <div>
              <div className="font-semibold">{history.preferred_room || "—"}</div>
              <div className="text-xs text-gray-500">Preferred Room</div>
            </div>
          </div>
        </div>
        {history.last_visit && (
          <p className="text-xs text-gray-400 mt-2">Last visit: {new Date(history.last_visit).toLocaleDateString("en-IN")}</p>
        )}
      </CardContent>
    </Card>
  );
}
