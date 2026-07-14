import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Zap } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface ElectricityBillLineInfo {
  line_type: string;
  meter_label: string | null;
  label: string | null;
  units: number | null;
  rate: number | null;
  amount: number | null;
}

interface ElectricityBillBreakupCardProps {
  bill: {
    bill_month: number;
    bill_year: number;
    landlord_total_amount: number;
    landlord_gst_applicable: boolean;
    landlord_gst_rate: number | null;
    landlord_gst_amount: number | null;
    electricity_bill_lines: ElectricityBillLineInfo[];
  };
}

// Read-only landlord bill breakup — same table/summary layout already used on
// the Electricity Bills page itself, surfaced here so an approver or accounts
// user working from the vendor bill doesn't have to separately look it up.
export function ElectricityBillBreakupCard({ bill }: ElectricityBillBreakupCardProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Zap className="h-4 w-4" />
          Electricity Bill — {MONTH_NAMES[bill.bill_month - 1]} {bill.bill_year}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b">
              <th className="text-left pb-1.5 font-medium">Type</th>
              <th className="text-left pb-1.5 font-medium">Label</th>
              <th className="text-right pb-1.5 font-medium">Units</th>
              <th className="text-right pb-1.5 font-medium">Rate</th>
              <th className="text-right pb-1.5 font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {bill.electricity_bill_lines.map((l, i) => (
              <tr key={i} className="border-b last:border-0">
                <td className="py-1.5 capitalize text-muted-foreground">{l.line_type}</td>
                <td className="py-1.5">{l.meter_label ?? l.label ?? "—"}</td>
                <td className="py-1.5 text-right">{l.units != null ? l.units : "—"}</td>
                <td className="py-1.5 text-right">{l.rate != null ? formatCurrency(l.rate) : "—"}</td>
                <td className="py-1.5 text-right font-medium">{formatCurrency(l.amount ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="bg-orange-50/50 border border-orange-200 rounded-lg p-3 text-xs space-y-1.5">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Base amount</span>
            <span>{formatCurrency(bill.landlord_total_amount)}</span>
          </div>
          {bill.landlord_gst_applicable && (
            <div className="flex justify-between text-muted-foreground">
              <span>GST ({bill.landlord_gst_rate}%)</span>
              <span>{formatCurrency(bill.landlord_gst_amount ?? 0)}</span>
            </div>
          )}
          <div className="flex justify-between font-medium pt-1 border-t border-orange-200/70">
            <span>Total payable</span>
            <span>{formatCurrency(bill.landlord_total_amount + (bill.landlord_gst_amount ?? 0))}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
