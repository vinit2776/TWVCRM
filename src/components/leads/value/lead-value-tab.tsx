"use client";

import { useCallback, useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { JourneyPanel } from "@/components/leads/value/journey-panel";
import { MoneyPanel } from "@/components/leads/value/money-panel";
import { SummaryPanel, type SummaryData } from "@/components/leads/value/summary-panel";
import { ValueHeader } from "@/components/leads/value/value-header";

/**
 * Value tab on the lead page (admin only: the caller gates it, and every API
 * route behind it re-checks the role). Each sub-tab loads its own data only
 * when first opened; inactive Radix tab content is unmounted, so closed
 * sub-tabs cost nothing. The header and the Summary share one small read of the
 * stored score. See docs/customer-value-tab-spec.md, section 4.
 */
export function LeadValueTab({ leadId }: { leadId: string }) {
  const [sub, setSub] = useState("summary");
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/value/summary`);
      if (!res.ok) throw new Error(res.status === 403 ? "Admins only" : "Could not load the summary");
      setSummary((await res.json()) as SummaryData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the summary");
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load]);

  const reload = useCallback(async () => {
    setLoading(true);
    await load();
  }, [load]);

  return (
    <div className="space-y-4">
      <ValueHeader latest={summary?.latest ?? null} loading={loading} error={error} leadId={leadId} onRecomputed={reload} />

      <Tabs value={sub} onValueChange={setSub} className="space-y-4">
        <TabsList>
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="journey">Journey</TabsTrigger>
          <TabsTrigger value="money">Money</TabsTrigger>
        </TabsList>

        <TabsContent value="summary" className="space-y-4">
          <SummaryPanel data={summary} loading={loading} error={error} onRetry={reload} onOpenMoney={() => setSub("money")} />
        </TabsContent>

        <TabsContent value="journey" className="space-y-4">
          <JourneyPanel leadId={leadId} />
        </TabsContent>

        <TabsContent value="money" className="space-y-4">
          <MoneyPanel leadId={leadId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
