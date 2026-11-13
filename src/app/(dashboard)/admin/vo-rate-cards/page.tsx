"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { DirectRatesPanel, type RateLocation } from "@/components/admin/vo-rates/direct-rates-panel";

export default function VoRateCardsPage() {
  const [locations, setLocations] = useState<RateLocation[]>([]);
  const [role, setRole] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      const [lRes, me] = await Promise.all([
        fetch("/api/locations").then((r) => r.json()).catch(() => ({ data: [] })),
        fetch("/api/me").then((r) => r.json()).catch(() => null),
      ]);
      setLocations(((lRes.data ?? lRes.locations ?? []) as RateLocation[]).slice().sort((a, b) => a.name.localeCompare(b.name)));
      setRole(me?.role ?? null);
      setReady(true);
    })();
  }, []);

  if (!ready) return <Loader2 className="h-5 w-5 animate-spin" />;

  return (
    <div className="space-y-6">
      <PageBreadcrumb resetTo={{ label: "VO rate cards" }} />
      <div>
        <h1 className="text-2xl font-semibold">Virtual Office rate cards</h1>
        <p className="text-sm text-muted-foreground">
          Guide and floor prices. Up to 12 months the rate is the fee for the term; for 24, 36 and 48 months it is the annual rate. An edit saves a new version and keeps the old one in the history.
        </p>
      </div>
      <DirectRatesPanel locations={locations} canEdit={role === "admin" || role === "manager"} />
    </div>
  );
}
