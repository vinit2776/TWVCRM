"use client";

import { useEffect, useState, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, LogIn, LogOut, Ban, DoorOpen, ChevronLeft, ChevronRight } from "lucide-react";

interface AccessLog {
  id: string;
  direction: "IN" | "OUT" | "DENIED";
  event_time: string;
  denial_reason: string | null;
  entity_name: string | null;
  device: { label: string } | null;
}

function monthRange(year: number, month: number) {
  return {
    from: new Date(year, month, 1).toISOString(),
    to:   new Date(year, month + 1, 1).toISOString(),
  };
}

function monthLabel(year: number, month: number) {
  return new Date(year, month, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

export function ContractAccessLogsSection({ contractId }: { contractId: string }) {
  const now = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth()); // 0-indexed
  const [logs,    setLogs]    = useState<AccessLog[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const { from, to } = monthRange(year, month);
      const { data } = await supabase
        .from("access_logs")
        .select("id, direction, event_time, denial_reason, entity_name, device:cosec_devices(label)")
        .eq("entity_id", contractId)
        .gte("event_time", from)
        .lt("event_time", to)
        .order("event_time", { ascending: false });
      if (!cancelled) {
        setLogs((data ?? []) as unknown as AccessLog[]);
        setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [contractId, year, month]); // eslint-disable-line react-hooks/exhaustive-deps

  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();

  function goPrev() {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  }
  function goNext() {
    if (isCurrentMonth) return;
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
  }

  const inCount     = logs.filter(l => l.direction === "IN").length;
  const deniedCount = logs.filter(l => l.direction === "DENIED").length;

  // Group by IST calendar date (YYYY-MM-DD), newest date first
  const grouped = useMemo(() => {
    const map = new Map<string, AccessLog[]>();
    for (const log of logs) {
      const date = new Date(log.event_time).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      if (!map.has(date)) map.set(date, []);
      map.get(date)!.push(log);
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [logs]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2">
            <DoorOpen size={16} />
            Door Access Log
          </CardTitle>

          {/* Month navigator */}
          <div className="flex items-center gap-1 shrink-0">
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={goPrev}>
              <ChevronLeft size={14} />
            </Button>
            <span className="text-sm font-medium w-36 text-center tabular-nums">
              {monthLabel(year, month)}
            </span>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={goNext} disabled={isCurrentMonth}>
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>

        {/* Month summary */}
        {!loading && logs.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {inCount} {inCount === 1 ? "entry" : "entries"}
            {deniedCount > 0 && <> · <span className="text-red-500">{deniedCount} denied</span></>}
            {" "}this month
          </p>
        )}
      </CardHeader>

      <CardContent className="p-0">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="animate-spin text-muted-foreground" size={22} />
          </div>
        ) : logs.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground px-4">
            <DoorOpen size={28} className="mx-auto mb-2 opacity-30" />
            <p className="text-sm font-medium">No access events in {monthLabel(year, month)}</p>
            <p className="text-xs mt-1">Navigate to a previous month to view older records.</p>
          </div>
        ) : (
          <div className="max-h-[28rem] overflow-y-auto">
            {grouped.map(([date, dateLogs]) => {
              // Parse date as local (IST) — avoid UTC offset shifting the date
              const [y, mo, d] = date.split("-").map(Number);
              const dateLabel = new Date(y, mo - 1, d).toLocaleDateString("en-IN", {
                weekday: "short", day: "numeric", month: "short",
              });

              return (
                <div key={date}>
                  {/* Sticky date group header */}
                  <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-1.5 bg-muted/60 backdrop-blur-sm border-y text-xs font-medium text-muted-foreground">
                    <span>{dateLabel}</span>
                    <span className="opacity-60">{dateLogs.length} event{dateLogs.length !== 1 ? "s" : ""}</span>
                  </div>

                  <div className="divide-y">
                    {dateLogs.map(log => {
                      const time = new Date(log.event_time).toLocaleTimeString("en-IN", {
                        hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
                      });
                      return (
                        <div
                          key={log.id}
                          className={`flex items-center gap-3 px-4 py-2.5 ${log.direction === "DENIED" ? "bg-red-50/40" : ""}`}
                        >
                          <div className="shrink-0">
                            {log.direction === "IN"
                              ? <LogIn  size={14} className="text-green-500" />
                              : log.direction === "OUT"
                                ? <LogOut size={14} className="text-blue-500" />
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

                          <div className="text-right shrink-0 space-y-0.5">
                            <div>
                              <Badge
                                variant={log.direction === "DENIED" ? "destructive" : "outline"}
                                className="text-xs"
                              >
                                {log.direction}
                              </Badge>
                            </div>
                            <div className="text-xs text-muted-foreground tabular-nums">{time}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
