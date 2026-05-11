"use client";

import { memo } from "react";
import { AlertTriangle } from "lucide-react";
import { useBookingForm } from "./booking-form-context";

export const OutstandingChargesSection = memo(function OutstandingChargesSection() {
  const { outstandingCharges, selectedChargeIds, setSelectedChargeIds, expandedChargeId, setExpandedChargeId } = useBookingForm();

  if (outstandingCharges.length === 0) return null;

  return (
    <div className="bg-amber-50 border border-amber-300 rounded-lg p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-2">
            <p className="font-semibold text-amber-800">
              Past dues: ₹{outstandingCharges.reduce((s, c) => s + c.total, 0).toLocaleString("en-IN")}
            </p>
            {selectedChargeIds.size > 0 && (
              <span className="text-xs font-semibold text-green-700 bg-green-100 px-2 py-0.5 rounded">
                +₹{outstandingCharges.filter(c => selectedChargeIds.has(c.id)).reduce((s, c) => s + c.total, 0).toLocaleString("en-IN")} added to bill
              </span>
            )}
          </div>
          <p className="text-sm text-amber-700 mb-2">
            Select charges to include in this booking&apos;s payment.
          </p>
          <div className="space-y-1">
            {outstandingCharges.map((c) => (
              <div key={c.id}>
                <div
                  className={`flex items-center gap-2 text-sm rounded px-3 py-2 border cursor-pointer transition-colors ${
                    selectedChargeIds.has(c.id) ? "bg-green-50 border-green-300" : "bg-white/70 border-amber-100 hover:border-amber-200"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedChargeIds.has(c.id)}
                    onChange={() => {
                      setSelectedChargeIds(prev => {
                        const next = new Set(prev);
                        if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                        return next;
                      });
                    }}
                    className="h-4 w-4 rounded border-amber-300"
                  />
                  <button
                    type="button"
                    className="flex-1 flex items-center justify-between text-left"
                    onClick={() => setExpandedChargeId(expandedChargeId === c.id ? null : c.id)}
                  >
                    <span className={selectedChargeIds.has(c.id) ? "text-green-900" : "text-amber-900"}>{c.description}</span>
                    <span className="font-semibold text-amber-800 ml-4 shrink-0">₹{c.total.toLocaleString("en-IN")}</span>
                  </button>
                </div>
                {expandedChargeId === c.id && (
                  <div className="ml-8 mt-1 mb-2 p-3 bg-white rounded border border-amber-100 text-xs space-y-1">
                    {c.booking && <p><span className="text-muted-foreground">From:</span> {c.booking.booking_number} ({c.booking.booking_date})</p>}
                    {c.charge_date && <p><span className="text-muted-foreground">Charged:</span> {c.charge_date}</p>}
                    {c.quantity && c.unit_price ? <p><span className="text-muted-foreground">Breakdown:</span> {c.quantity} × ₹{c.unit_price.toLocaleString("en-IN")} = ₹{c.total.toLocaleString("en-IN")}</p> : null}
                    {c.notes && <p><span className="text-muted-foreground">Reason:</span> {c.notes}</p>}
                    {c.proof_path && <p><a href={`/api/documents/view?path=${encodeURIComponent(c.proof_path)}`} target="_blank" rel="noopener noreferrer" className="text-primary underline">View Proof Photo</a></p>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});
