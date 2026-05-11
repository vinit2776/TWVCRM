"use client";

import { memo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import type { SpaceFacility } from "@/types";
import { useBookingForm } from "./booking-form-context";

export const FacilitiesSection = memo(function FacilitiesSection() {
  const { selectedSpace, selectedFacilities, setSelectedFacilities } = useBookingForm();

  if (!selectedSpace?.facilities || selectedSpace.facilities.length === 0) return null;

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">4. Facilities</CardTitle></CardHeader>
      <CardContent>
        <div className="space-y-2">
          {selectedSpace.facilities.filter(f => f.is_available).map((f: SpaceFacility) => (
            <div key={f.id} className="flex items-center gap-3">
              <input
                type="checkbox"
                id={`fac-${f.id}`}
                checked={selectedFacilities.includes(f.id)}
                onChange={(e) => {
                  setSelectedFacilities(prev =>
                    e.target.checked ? [...prev, f.id] : prev.filter(id => id !== f.id)
                  );
                }}
                className="h-4 w-4 rounded border-gray-300"
              />
              <label htmlFor={`fac-${f.id}`} className="text-sm flex-1 cursor-pointer">
                {f.name}
              </label>
              <span className="text-xs text-muted-foreground">
                {f.is_complimentary ? "Free" : formatCurrency(f.charge_per_use)}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
});
