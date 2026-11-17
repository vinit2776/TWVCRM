"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DirectRatesPanel, type RateLocation } from "@/components/admin/vo-rates/direct-rates-panel";
import { AggregatorRatesPanel, type RateAggregator } from "@/components/admin/vo-rates/aggregator-rates-panel";

export default function VoRateCardsPage() {
  const [locations, setLocations] = useState<RateLocation[]>([]);
  const [aggregators, setAggregators] = useState<RateAggregator[]>([]);
  const [role, setRole] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      const [lRes, me, aRes] = await Promise.all([
        fetch("/api/locations").then((r) => r.json()).catch(() => ({ data: [] })),
        fetch("/api/me").then((r) => r.json()).catch(() => null),
        fetch("/api/aggregators?limit=500&sort_by=name&sort_order=asc").then((r) => r.json()).catch(() => ({ data: [] })),
      ]);
      setLocations(((lRes.data ?? lRes.locations ?? []) as RateLocation[]).slice().sort((a, b) => a.name.localeCompare(b.name)));
      setAggregators(((aRes.data ?? []) as RateAggregator[]).map((a) => ({ id: a.id, name: a.name })));
      setRole(me?.role ?? null);
      setReady(true);
    })();
  }, []);

  const canEdit = role === "admin" || role === "manager";

  if (!ready) return <Loader2 className="h-5 w-5 animate-spin" />;

  return (
    <div className="space-y-6">
      <PageBreadcrumb resetTo={{ label: "VO rate cards" }} />
      <div>
        <h1 className="text-2xl font-semibold">Virtual Office rate cards</h1>
        <p className="text-sm text-muted-foreground">
          Guide and floor prices for direct customers, and one custom card per aggregator. Every change saves a new version and keeps the old one in the history.
        </p>
      </div>
      <Tabs defaultValue="direct">
        <TabsList>
          <TabsTrigger value="direct">Direct customers</TabsTrigger>
          <TabsTrigger value="aggregators">Aggregators</TabsTrigger>
        </TabsList>
        <TabsContent value="direct" className="pt-4">
          <DirectRatesPanel locations={locations} canEdit={canEdit} />
        </TabsContent>
        <TabsContent value="aggregators" className="pt-4">
          <AggregatorRatesPanel aggregators={aggregators} locations={locations} canEdit={canEdit} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
