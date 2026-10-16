"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { JourneyPanel } from "@/components/leads/value/journey-panel";

/**
 * Value tab on the lead page (admin only — the caller gates it, and every API
 * route behind it re-checks the role). Each sub-tab loads its own data only
 * when first opened; inactive Radix tab content is unmounted, so closed
 * sub-tabs cost nothing. See docs/customer-value-tab-spec.md, section 4.
 */
export function LeadValueTab({ leadId }: { leadId: string }) {
  return (
    <Tabs defaultValue="journey" className="space-y-4">
      <TabsList>
        <TabsTrigger value="journey">Journey</TabsTrigger>
      </TabsList>

      <TabsContent value="journey" className="space-y-4">
        <JourneyPanel leadId={leadId} />
      </TabsContent>
    </Tabs>
  );
}
