"use client";

import { useCallback, useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ComparePanel } from "@/components/leads/value/compare-panel";
import { CostsPanel } from "@/components/leads/value/costs-panel";
import { ElectricityPanel } from "@/components/leads/value/electricity-panel";
import { JourneyPanel } from "@/components/leads/value/journey-panel";
import { MoneyPanel } from "@/components/leads/value/money-panel";
import { PerformancePanel } from "@/components/leads/value/performance-panel";
import { SummaryPanel, type SummaryData } from "@/components/leads/value/summary-panel";
import { WifiPanel } from "@/components/leads/value/wifi-panel";
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
      // no-store: after Recompute the page must show the new score, not the 60-second browser copy.
      const res = await fetch(`/api/leads/${leadId}/value/summary`, { cache: "no-store" });
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

  // Recompute changes what Performance would show too, so remount it on the next visit.
  const [performanceKey, setPerformanceKey] = useState(0);
  const reload = useCallback(async () => {
    setLoading(true);
    await load();
    setPerformanceKey((k) => k + 1);
  }, [load]);

  return (
    <div className="space-y-4">
      <ValueHeader latest={summary?.latest ?? null} loading={loading} error={error} leadId={leadId} onRecomputed={reload} />

      <Tabs value={sub} onValueChange={setSub} className="space-y-4">
        <TabsList>
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
          <TabsTrigger value="compare">Compare</TabsTrigger>
          <TabsTrigger value="costs">Costs</TabsTrigger>
          <TabsTrigger value="electricity">Electricity</TabsTrigger>
          <TabsTrigger value="wifi">Wi-Fi</TabsTrigger>
          <TabsTrigger value="journey">Journey</TabsTrigger>
          <TabsTrigger value="money">Money</TabsTrigger>
        </TabsList>

        <TabsContent value="summary" className="space-y-4">
          <SummaryPanel leadId={leadId} data={summary} loading={loading} error={error} onRetry={reload} onOpenMoney={() => setSub("money")} />
        </TabsContent>

        <TabsContent value="performance" className="space-y-4">
          <PerformancePanel key={performanceKey} leadId={leadId} />
        </TabsContent>

        <TabsContent value="compare" className="space-y-4">
          <ComparePanel key={performanceKey} leadId={leadId} />
        </TabsContent>

        <TabsContent value="costs" className="space-y-4">
          <CostsPanel key={performanceKey} leadId={leadId} />
        </TabsContent>

        <TabsContent value="electricity" className="space-y-4">
          <ElectricityPanel leadId={leadId} />
        </TabsContent>

        <TabsContent value="wifi" className="space-y-4">
          <WifiPanel leadId={leadId} />
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
