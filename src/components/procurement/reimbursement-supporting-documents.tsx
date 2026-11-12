"use client";

import { useCallback, useState } from "react";
import { FileText, Loader2, Paperclip } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDate } from "@/lib/utils";

interface SupportingDocument {
  id: string;
  file_name: string;
  file_mime_type: string;
  created_at: string;
  signed_url: string | null;
}

export function ReimbursementSupportingDocuments({
  statementId,
  count,
  triggerClassName = "flex items-center gap-0.5 text-pink-700 hover:text-pink-900 hover:underline",
}: {
  statementId: string;
  count: number;
  /** Overrides the trigger's color classes so this fits the surrounding card's
   *  theme (e.g. the Tally Inbox's neutral palette vs. the MR page's pink one). */
  triggerClassName?: string;
}) {
  const [docs, setDocs] = useState<SupportingDocument[] | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchDocs = useCallback(async () => {
    if (docs || loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/supporting-documents`);
      if (res.ok) {
        const json = await res.json();
        setDocs(json.data ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [statementId, docs, loading]);

  if (count === 0) return null;

  return (
    <Popover onOpenChange={(open) => open && fetchDocs()}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={triggerClassName}
          title="View supporting documents"
        >
          <Paperclip className="h-3 w-3" /> {count}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <p className="text-xs font-medium text-muted-foreground px-1">Supporting documents</p>
        <p className="text-[11px] text-muted-foreground px-1 pb-1.5">
          Included as extra pages in the invoice sent to the customer.
        </p>
        {loading && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-1 py-1">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        )}
        {!loading && docs?.length === 0 && (
          <p className="text-xs text-muted-foreground px-1 py-1">No documents found.</p>
        )}
        {!loading &&
          docs?.map((doc) => (
            <a
              key={doc.id}
              href={doc.signed_url ?? "#"}
              target="_blank"
              rel="noreferrer"
              className="flex items-start gap-1.5 text-xs text-teal-700 hover:underline px-1 py-1 rounded hover:bg-muted"
            >
              <FileText className="h-3 w-3 mt-0.5 flex-shrink-0" />
              <span className="truncate">
                {doc.file_name}
                <span className="block text-[10px] text-muted-foreground">{formatDate(doc.created_at)}</span>
              </span>
            </a>
          ))}
      </PopoverContent>
    </Popover>
  );
}
