"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLocations } from "@/hooks/use-locations";
import { MapPin } from "lucide-react";

interface LocationSelectorProps {
  value: string | null;
  onValueChange: (id: string | null) => void;
  includeAllOption?: boolean;
  includeOtherOption?: boolean;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
}

export function LocationSelector({
  value,
  onValueChange,
  includeAllOption = false,
  includeOtherOption = false,
  placeholder = "Select location",
  disabled = false,
}: LocationSelectorProps) {
  const { locations, loading } = useLocations();

  return (
    <Select
      value={value || (includeAllOption ? "__all__" : "")}
      onValueChange={(v) => onValueChange(v === "__all__" ? null : v)}
      disabled={disabled || loading}
    >
      <SelectTrigger>
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
          <SelectValue placeholder={loading ? "Loading..." : placeholder} />
        </div>
      </SelectTrigger>
      <SelectContent>
        {includeAllOption && (
          <SelectItem value="__all__">All Locations</SelectItem>
        )}
        {locations.map((loc) => (
          <SelectItem key={loc.id} value={loc.id}>
            {loc.name} ({loc.code})
          </SelectItem>
        ))}
        {includeOtherOption && (
          <SelectItem value="__other__">Others</SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}
