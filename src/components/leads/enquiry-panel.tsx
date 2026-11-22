"use client";

import { useCallback, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ContactBackContent } from "@/components/leads/contact-back-content";
import { useEnquiryNotifications } from "@/providers/enquiry-notifications-provider";
import { afterFinishing, panelNeighbours } from "@/lib/enquiry-panel";

/**
 * The check panel: one enquiry's call form beside the list it came from, so the list does not lose
 * its place. Open while the address has `?enquiry=<id>`: Back closes it and a refresh reopens it.
 * Previous and next step through the open enquiries; leaving with something typed asks first.
 */
export function EnquiryPanel({ enquiryId, onNavigate }: { enquiryId: string | null; onNavigate: (id: string | null) => void }) {
  const { items } = useEnquiryNotifications();
  const openIds = useMemo(() => items.filter((i) => !i.resolvedAt && i.leadId).map((i) => i.enquiryId), [items]);
  const [dirty, setDirty] = useState(false);
  // The ids as they were when this enquiry was opened, so saving one does not shuffle the order under the person.
  const [order, setOrder] = useState<string[]>([]);
  // Fixed when the panel opens. After a refresh the open enquiries may still be loading, so an order of
  // just this one enquiry is filled in once they arrive.
  const loadedLater = order.length === 1 && openIds.length > 1 && openIds.includes(enquiryId ?? "");
  if (enquiryId && (!order.includes(enquiryId) || loadedLater)) setOrder(openIds.includes(enquiryId) ? openIds : [enquiryId, ...openIds]);
  if (!enquiryId && order.length > 0) setOrder([]);
  const { prev, next, position } = panelNeighbours(order, enquiryId ?? "");

  const leave = useCallback(
    (to: string | null) => {
      if (dirty && !window.confirm("You have unsaved changes. Leave without saving?")) return;
      setDirty(false);
      onNavigate(to);
    },
    [dirty, onNavigate],
  );

  return (
    <Sheet open={!!enquiryId} onOpenChange={(open) => !open && leave(null)}>
      <SheetContent className="w-full overflow-y-auto p-4 sm:max-w-2xl">
        <SheetHeader className="pr-8">
          <SheetTitle>Check this enquiry</SheetTitle>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Button type="button" variant="outline" size="icon" className="h-10 w-10" disabled={!prev} onClick={() => leave(prev)} aria-label="Previous enquiry">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button type="button" variant="outline" size="icon" className="h-10 w-10" disabled={!next} onClick={() => leave(next)} aria-label="Next enquiry">
              <ChevronRight className="h-4 w-4" />
            </Button>
            {position && <span>{position} of {order.length}</span>}
          </div>
        </SheetHeader>
        {enquiryId && (
          <div className="mt-4">
            <ContactBackContent
              key={enquiryId}
              enquiryId={enquiryId}
              wrapperClass="w-full"
              onDirtyChange={setDirty}
              onDone={() => {
                setDirty(false);
                onNavigate(afterFinishing(order, enquiryId));
              }}
            />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
