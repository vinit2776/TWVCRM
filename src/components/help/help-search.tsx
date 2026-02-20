"use client";

import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface HelpSearchProps {
  value: string;
  onChange: (value: string) => void;
  resultCount?: number;
}

export function HelpSearch({ value, onChange, resultCount }: HelpSearchProps) {
  return (
    <div className="flex items-center gap-3">
      <div className="relative max-w-md flex-1">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search help topics, FAQs, guides..."
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="pl-9 pr-9"
        />
        {value && (
          <button
            onClick={() => onChange("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {value && resultCount !== undefined && (
        <Badge variant="secondary" className="shrink-0">
          {resultCount} result{resultCount !== 1 ? "s" : ""}
        </Badge>
      )}
    </div>
  );
}
