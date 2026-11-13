"use client";

/**
 * PaymentLinkStrip — shows the booking's Razorpay payment link whenever one exists,
 * with Copy and Open, so staff can paste it into WhatsApp, SMS or anywhere else.
 */

import { Button } from "@/components/ui/button";
import { Copy, ExternalLink, Link2 } from "lucide-react";
import { toast } from "sonner";

export function PaymentLinkStrip({ url }: { url: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Payment link copied");
    } catch {
      toast.error("Couldn't copy. Select the link and copy it by hand.");
    }
  };
  return (
    <div className="rounded-lg border bg-card p-3 flex items-center gap-3">
      <Link2 className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground">Payment link</div>
        <div className="text-sm font-mono truncate select-all">{url}</div>
      </div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={copy}>
        <Copy className="mr-1 h-3.5 w-3.5" />Copy
      </Button>
      <Button variant="ghost" size="sm" className="shrink-0" asChild>
        <a href={url} target="_blank" rel="noopener noreferrer" aria-label="Open payment link">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </Button>
    </div>
  );
}
