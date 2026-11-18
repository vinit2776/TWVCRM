"use client";

/**
 * Shows exactly what a customer is about to be emailed: recipients, subject,
 * attachment and the rendered body. The body comes from the same builders the
 * send routes use (src/lib/gst-invoice-email.ts). It is rendered in a fully
 * sandboxed iframe (no scripts, no navigation) so CRM data can't affect the page.
 */
import { Mail, Paperclip } from "lucide-react";

export interface CustomerEmailPreviewData {
  to: string[];
  cc?: string[];
  subject: string;
  attachmentName: string;
  html: string;
  /** Shown under the preview, e.g. "The payment link is created when this is sent." */
  note?: string;
}

export function CustomerEmailPreview({ preview, heading = "Email the customer will receive" }: {
  preview: CustomerEmailPreviewData;
  heading?: string;
}) {
  return (
    <div className="rounded border bg-background text-foreground text-xs">
      <div className="flex items-center gap-1.5 border-b bg-muted/40 px-2.5 py-1.5 font-semibold">
        <Mail className="h-3.5 w-3.5" aria-hidden /> {heading}
      </div>
      <div className="space-y-0.5 px-2.5 py-2">
        {preview.to.length > 0 ? (
          <>
            <div><span className="text-muted-foreground">To:</span> {preview.to.join(", ")}</div>
            {preview.cc && preview.cc.length > 0 && (
              <div><span className="text-muted-foreground">Cc:</span> {preview.cc.join(", ")}</div>
            )}
            <div><span className="text-muted-foreground">Subject:</span> {preview.subject}</div>
            <div className="flex items-center gap-1">
              <Paperclip className="h-3 w-3 text-muted-foreground" aria-hidden />
              <span className="font-mono">{preview.attachmentName}</span>
              <span className="text-muted-foreground">(the file you attached)</span>
            </div>
          </>
        ) : (
          <div className="text-amber-800">No email address is on file for this customer, so nothing will be sent.</div>
        )}
      </div>
      {preview.to.length > 0 && (
        <iframe
          title="Customer email preview"
          sandbox=""
          srcDoc={`<body style="margin:12px;font-family:sans-serif;font-size:14px;color:#333">${preview.html}</body>`}
          className="h-72 w-full border-t bg-white"
        />
      )}
      {preview.note && <div className="border-t px-2.5 py-1.5 text-[11px] text-muted-foreground">{preview.note}</div>}
    </div>
  );
}
