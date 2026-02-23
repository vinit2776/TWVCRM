"use client";

import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Mail, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { formatDateTime } from "@/lib/utils";
import type { CaseEmail } from "@/types";

interface CaseEmailsTabProps {
  caseId: string;
}

export function CaseEmailsTab({ caseId }: CaseEmailsTabProps) {
  const [emails, setEmails] = useState<CaseEmail[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchEmails = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}`);
      if (res.ok) {
        const json = await res.json();
        setEmails(json.data?.emails || []);
      }
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    fetchEmails();
  }, [fetchEmails]);

  if (loading) {
    return <div className="text-center py-8 text-muted-foreground">Loading emails...</div>;
  }

  if (emails.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm">
        <Mail className="h-8 w-8 mx-auto mb-2 opacity-50" />
        No emails linked to this case.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {emails.map((email) => (
        <Card key={email.id}>
          <CardContent className="pt-4">
            <div className="flex items-start gap-3">
              <div className="mt-1">
                {email.direction === "inbound" ? (
                  <ArrowDownLeft className="h-4 w-4 text-blue-500" />
                ) : (
                  <ArrowUpRight className="h-4 w-4 text-green-500" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm truncate">{email.subject}</span>
                  <Badge variant="outline" className="text-xs">
                    {email.direction}
                  </Badge>
                  {email.has_attachments && (
                    <Badge variant="secondary" className="text-xs">Attachments</Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                  <span>From: {email.from_email}</span>
                  <span>|</span>
                  <span>{formatDateTime(email.processed_at || email.created_at)}</span>
                </div>
                {email.body_preview && (
                  <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
                    {email.body_preview}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
