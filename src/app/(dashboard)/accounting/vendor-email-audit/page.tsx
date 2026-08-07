"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  MailX, Mail, Loader2, ChevronLeft, AlertCircle, TrendingDown,
} from "lucide-react";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import { PageBreadcrumb } from "@/components/page-breadcrumb";

interface VendorEmailGap {
  vendor_id: string;
  vendor_name: string;
  contact_name: string | null;
  contact_phone: string | null;
  pending_bills_count: number;
  bills_last_90d: number;
  total_billed_last_90d: number;
  last_bill_date: string | null;
  dismissals_in_window: number;
}

interface AuditResponse {
  count: number;
  vendors: VendorEmailGap[];
  high_priority_count: number;
  total_pending_value: number;
}

/**
 * Bulk-fix page for vendors missing contact_email.
 *
 * One row per vendor, inline editable. Sorted by pending bills first,
 * then dismissal count, then most recent. Save reloads the row so it
 * disappears once the email is added.
 *
 * Roles: admin, manager, accounts, office_admin.
 */
export default function VendorEmailAuditPage() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [emailInputs, setEmailInputs] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/finance-intelligence/vendor-email-nag/audit");
      if (!res.ok) throw new Error("Failed to load");
      const json: AuditResponse = await res.json();
      setData(json);
    } catch {
      toast.error("Failed to load vendor email audit");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSave = async (vendor: VendorEmailGap) => {
    const email = (emailInputs[vendor.vendor_id] ?? "").trim();
    if (!email || !email.includes("@")) {
      toast.error("Enter a valid email address");
      return;
    }
    setSavingId(vendor.vendor_id);
    try {
      const res = await fetch(`/api/procurement/vendors/${vendor.vendor_id}/email`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_email: email }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(typeof json?.error === "string" ? json.error : "Failed");
        return;
      }
      toast.success(`Email saved for ${vendor.vendor_name}`);
      // Remove the row optimistically
      if (data) {
        setData({
          ...data,
          count: data.count - 1,
          vendors: data.vendors.filter((v) => v.vendor_id !== vendor.vendor_id),
        });
      }
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageBreadcrumb resetTo={{ label: "Vendor Email Audit" }} />
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/accounting" className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MailX className="h-6 w-6 text-amber-600" />
            Vendor Email Audit
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Vendors below have no email address, so payment confirmations cannot reach them. Fix them inline.
          </p>
        </div>
      </div>

      {/* Summary tiles */}
      {data && !loading && (
        <div className="grid grid-cols-3 gap-3 text-sm">
          <Card>
            <CardContent className="pt-4 pb-4 text-center">
              <p className="text-xs text-muted-foreground">Vendors missing email</p>
              <p className={`text-2xl font-bold mt-1 ${data.count > 0 ? "text-amber-700" : "text-emerald-700"}`}>
                {data.count}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4 text-center">
              <p className="text-xs text-muted-foreground">High priority (pending bills)</p>
              <p className={`text-2xl font-bold mt-1 ${data.high_priority_count > 0 ? "text-red-700" : "text-emerald-700"}`}>
                {data.high_priority_count}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4 text-center">
              <p className="text-xs text-muted-foreground">90-day billed value</p>
              <p className="text-2xl font-bold mt-1">{formatCurrency(data.total_pending_value)}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="flex items-center gap-2 py-10 justify-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading audit…
        </div>
      ) : !data || data.count === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-2">
            <Mail className="h-10 w-10 text-emerald-600 mx-auto" />
            <p className="text-base font-semibold text-emerald-800">All vendors have an email on file</p>
            <p className="text-sm text-muted-foreground">
              Payment confirmations will reach every vendor when payments are recorded.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {data.vendors.map((v) => {
            const isHighPriority = v.pending_bills_count > 0;
            const hasDismissals = v.dismissals_in_window > 0;
            return (
              <Card
                key={v.vendor_id}
                className={isHighPriority ? "border-amber-300" : ""}
              >
                <CardContent className="pt-4 pb-4 space-y-3">
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold">{v.vendor_name}</p>
                        {isHighPriority && (
                          <Badge variant="secondary" className="bg-red-100 text-red-700 text-[10px]">
                            <AlertCircle className="h-3 w-3 mr-0.5" />
                            {v.pending_bills_count} pending bill{v.pending_bills_count === 1 ? "" : "s"}
                          </Badge>
                        )}
                        {hasDismissals && (
                          <Badge variant="secondary" className="bg-amber-100 text-amber-800 text-[10px]">
                            <TrendingDown className="h-3 w-3 mr-0.5" />
                            Skipped {v.dismissals_in_window}× recently
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                        {v.contact_name && <span>👤 {v.contact_name}</span>}
                        {v.contact_phone && <span>📞 {v.contact_phone}</span>}
                        <span>📅 {v.bills_last_90d} bills · {formatCurrency(v.total_billed_last_90d)} in last 90 days</span>
                        {v.last_bill_date && <span>Last: {formatDate(v.last_bill_date)}</span>}
                      </div>
                    </div>
                  </div>

                  {/* Inline email editor */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="relative flex-1 min-w-[200px]">
                      <Mail className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                      <Input
                        type="email"
                        placeholder={`Add email for ${v.vendor_name}`}
                        value={emailInputs[v.vendor_id] ?? ""}
                        onChange={(e) =>
                          setEmailInputs((prev) => ({ ...prev, [v.vendor_id]: e.target.value }))
                        }
                        className="pl-8 h-8 text-sm"
                        disabled={savingId === v.vendor_id}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && savingId !== v.vendor_id) handleSave(v);
                        }}
                      />
                    </div>
                    <Button
                      size="sm"
                      onClick={() => handleSave(v)}
                      disabled={savingId === v.vendor_id || !(emailInputs[v.vendor_id] ?? "").trim()}
                    >
                      {savingId === v.vendor_id && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
                      Save email
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
