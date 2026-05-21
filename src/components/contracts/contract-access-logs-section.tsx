"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, LogIn, LogOut, Ban, DoorOpen } from "lucide-react";
import { formatDate } from "@/lib/utils";

interface AccessLog {
  id: string;
  direction: "IN" | "OUT" | "DENIED";
  event_time: string;
  denial_reason: string | null;
  entity_name: string | null;
  device: { label: string } | null;
}

export function ContractAccessLogsSection({ contractId }: { contractId: string }) {
  const [logs, setLogs] = useState<AccessLog[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from("access_logs")
        .select("id, direction, event_time, denial_reason, entity_name, device:cosec_devices(label)")
        .eq("entity_id", contractId)
        .order("event_time", { ascending: false })
        .limit(200);
      setLogs((data ?? []) as unknown as AccessLog[]);
      setLoading(false);
    }
    load();
  }, [contractId]); // eslint-disable-line react-hooks/exhaustive-deps

  const inCount = logs.filter(l => l.direction === "IN").length;
  const deniedCount = logs.filter(l => l.direction === "DENIED").length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <DoorOpen size={16} />
          Door Access Log
          {!loading && logs.length > 0 && (
            <span className="text-xs font-normal text-muted-foreground ml-1">
              (last {logs.length} events · {inCount} entries{deniedCount > 0 ? ` · ${deniedCount} denied` : ""})
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="animate-spin text-muted-foreground" size={22} />
          </div>
        ) : logs.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground px-4">
            <DoorOpen size={28} className="mx-auto mb-2 opacity-30" />
            <p className="text-sm font-medium">No access events yet</p>
            <p className="text-xs mt-1">Events appear once this contract&apos;s users start using the door access system.</p>
          </div>
        ) : (
          <div className="divide-y max-h-80 overflow-y-auto">
            {logs.map(log => (
              <div key={log.id} className={`flex items-center gap-3 px-4 py-2.5 ${log.direction === "DENIED" ? "bg-red-50/40" : ""}`}>
                <div className="shrink-0">
                  {log.direction === "IN"    ? <LogIn  size={14} className="text-green-500" />
                   : log.direction === "OUT" ? <LogOut size={14} className="text-blue-500" />
                                             : <Ban    size={14} className="text-red-400" />}
                </div>
                <div className="flex-1 min-w-0 text-sm">
                  <span className="font-medium">{log.entity_name || "Unknown"}</span>
                  {log.device?.label && (
                    <span className="text-muted-foreground text-xs ml-2">@ {log.device.label}</span>
                  )}
                  {log.denial_reason && (
                    <span className="ml-2 text-xs text-red-500">· {log.denial_reason}</span>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <Badge variant={log.direction === "DENIED" ? "destructive" : "outline"} className="text-xs">{log.direction}</Badge>
                  <div className="text-xs text-muted-foreground mt-0.5">{formatDate(log.event_time)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
