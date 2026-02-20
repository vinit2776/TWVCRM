"use client";

import { Button } from "@/components/ui/button";
import { BOOKING_NOTE_TEMPLATES } from "@/lib/constants";
import { StickyNote } from "lucide-react";

export function BookingNotesTemplates({ onInsert }: { onInsert: (text: string) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <StickyNote className="w-3 h-3" /> Quick templates:
      </div>
      <div className="flex flex-wrap gap-1">
        {BOOKING_NOTE_TEMPLATES.map(tmpl => (
          <Button
            key={tmpl}
            variant="outline"
            size="sm"
            className="text-xs h-7"
            onClick={() => onInsert(tmpl)}
          >
            {tmpl}
          </Button>
        ))}
      </div>
    </div>
  );
}
