"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Users, Star, AlertTriangle, TrendingDown } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

interface SegmentCustomer {
  lead_id?: string;
  name: string;
  company?: string;
  phone?: string;
  total_bookings: number;
  total_spent: number;
  last_visit?: string;
  avg_feedback?: number | null;
}

interface Segment {
  segment: string;
  label: string;
  description: string;
  count: number;
  customers: SegmentCustomer[];
}

const SEGMENT_ICONS: Record<string, React.ReactNode> = {
  frequent: <Users className="w-4 h-4 text-green-600" />,
  lapsed: <TrendingDown className="w-4 h-4 text-red-600" />,
  high_spender: <Star className="w-4 h-4 text-purple-600" />,
  low_feedback: <AlertTriangle className="w-4 h-4 text-orange-600" />,
};

const SEGMENT_COLORS: Record<string, string> = {
  frequent: "border-green-200 bg-green-50",
  lapsed: "border-red-200 bg-red-50",
  high_spender: "border-purple-200 bg-purple-50",
  low_feedback: "border-orange-200 bg-orange-50",
};

export function CustomerSegments({ locationId }: { locationId?: string }) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (locationId) params.set("location_id", locationId);

    fetch(`/api/bookings/analytics/segments?${params}`)
      .then(r => r.json())
      .then(json => { if (json.data) setSegments(json.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [locationId]);

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {segments.map(segment => (
        <Card key={segment.segment} className={`border ${SEGMENT_COLORS[segment.segment] || ""}`}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              {SEGMENT_ICONS[segment.segment]}
              {segment.label}
              <Badge variant="secondary" className="ml-auto">{segment.count}</Badge>
            </CardTitle>
            <p className="text-xs text-gray-500">{segment.description}</p>
          </CardHeader>
          <CardContent className="pt-0">
            {segment.customers.length === 0 ? (
              <p className="text-sm text-gray-400 py-2">No customers in this segment</p>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {segment.customers.slice(0, 10).map((c, i) => (
                  <div key={i} className="flex justify-between items-center text-sm py-1 border-b border-gray-100 last:border-0">
                    <div>
                      <div className="font-medium">{c.name}</div>
                      {c.company && <div className="text-xs text-gray-500">{c.company}</div>}
                    </div>
                    <div className="text-right text-xs">
                      <div>{c.total_bookings} bookings</div>
                      <div className="text-gray-500">{formatCurrency(c.total_spent)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
