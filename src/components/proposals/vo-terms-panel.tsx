"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface TermsData {
  mode: "off" | "on";
  frozen: boolean;
  notSetUp?: boolean;
  clauses: { code: string; version: number; text: string }[];
  warnings: { code: string; kind: string; message: string }[];
}

/** Read-only list of the library clauses a VO proposal carries, with any clause still waiting on legal. Hidden when the terms library is off. */
export function VoTermsPanel({ proposalId }: { proposalId: string }) {
  const [data, setData] = useState<TermsData | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/proposals/${proposalId}/vo-terms`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setData(j.data); })
      .catch(() => {});
    return () => { live = false; };
  }, [proposalId]);

  if (!data || data.mode !== "on" || data.notSetUp) return null;

  return (
    <Card className="mb-4">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          Terms
          <Badge variant="outline">{data.frozen ? "Sent with proposal" : "Preview"}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {data.warnings.length > 0 && (
          <ul className="space-y-1 rounded-md bg-amber-50 p-3 text-amber-800">
            {data.warnings.map((w, i) => (
              <li key={`${w.code}-${i}`} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{w.message}</span>
              </li>
            ))}
          </ul>
        )}
        {data.clauses.length === 0 ? (
          <p className="text-muted-foreground">No approved clauses apply to this proposal.</p>
        ) : (
          <ol className="space-y-2">
            {data.clauses.map((c) => (
              <li key={c.code} className="flex gap-2">
                <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">{c.code}</span>
                <span>{c.text}</span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
