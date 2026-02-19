"use client";

import { formatCurrency } from "@/lib/utils";

interface AgingBucket {
  count: number;
  total: number;
  contracts: string[];
}

interface AgingBucketsProps {
  buckets: {
    current: AgingBucket;
    overdue_30: AgingBucket;
    overdue_60: AgingBucket;
    overdue_90: AgingBucket;
  };
  onBucketClick?: (bucket: string, contractIds: string[]) => void;
}

const bucketConfig = [
  { key: "current", label: "Current", sublabel: "0-30 days", color: "bg-green-50 border-green-200 text-green-800", valueColor: "text-green-700" },
  { key: "overdue_30", label: "Overdue", sublabel: "31-60 days", color: "bg-amber-50 border-amber-200 text-amber-800", valueColor: "text-amber-700" },
  { key: "overdue_60", label: "Overdue", sublabel: "61-90 days", color: "bg-orange-50 border-orange-200 text-orange-800", valueColor: "text-orange-700" },
  { key: "overdue_90", label: "Overdue", sublabel: "90+ days", color: "bg-red-50 border-red-200 text-red-800", valueColor: "text-red-700" },
] as const;

export function AgingBuckets({ buckets, onBucketClick }: AgingBucketsProps) {
  const hasAnyOverdue = buckets.overdue_30.total > 0 || buckets.overdue_60.total > 0 || buckets.overdue_90.total > 0;

  if (!hasAnyOverdue && buckets.current.total === 0) return null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {bucketConfig.map(({ key, label, sublabel, color, valueColor }) => {
        const bucket = buckets[key];
        if (bucket.total === 0 && key !== "current") return (
          <div key={key} className={`rounded-lg border p-3 opacity-50 ${color}`}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium">{label}</p>
                <p className="text-[10px] opacity-70">{sublabel}</p>
              </div>
            </div>
            <p className={`text-sm font-bold mt-1 ${valueColor}`}>—</p>
            <p className="text-[10px] opacity-70 mt-0.5">0 contracts</p>
          </div>
        );

        return (
          <div
            key={key}
            className={`rounded-lg border p-3 ${color} ${onBucketClick && bucket.total > 0 ? "cursor-pointer hover:shadow-md transition-shadow" : ""}`}
            onClick={() => onBucketClick && bucket.total > 0 && onBucketClick(key, bucket.contracts)}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium">{label}</p>
                <p className="text-[10px] opacity-70">{sublabel}</p>
              </div>
            </div>
            <p className={`text-sm font-bold mt-1 ${valueColor}`}>
              {formatCurrency(bucket.total)}
            </p>
            <p className="text-[10px] opacity-70 mt-0.5">
              {bucket.count} contract{bucket.count !== 1 ? "s" : ""}
            </p>
          </div>
        );
      })}
    </div>
  );
}
