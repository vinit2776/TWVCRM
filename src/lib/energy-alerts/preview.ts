// What the rule editor draws: the usual kW curve for today (what each slot is compared
// against) and today's readings so far. Pure; the tolerance band is applied by the caller
// so moving a slider needs no refetch.

import { istToday, type HolidayEntry, type LedgerBucket } from "@/lib/energy-baseline";
import { makeBaselineCtx, MIN_PEER_DAYS, typicalFor } from "./baseline";
import type { DayClass } from "@/lib/energy-today";

export const DAY_CLASS_LABELS: Record<DayClass, string> = {
  weekday: "a Mon–Fri working day",
  saturday: "a Saturday",
  off: "a Sunday or holiday",
};

export interface CurveSlot {
  k: number; // 15-minute slot of the IST day, 0..95
  time: string; // HH:MM IST
  typical: number | null; // usual kW for this slot
  actual: number | null; // today's average kW over this slot, null until it has completed
}

export interface CurvePreview {
  date: string;
  dayLabel: string;
  peers: number; // comparable days the usual is built from
  minPeers: number;
  enough: boolean;
  lastSlot: number | null; // latest completed slot today
  slots: CurveSlot[];
}

const slotTime = (k: number) => `${String(Math.floor(k / 4)).padStart(2, "0")}:${String((k % 4) * 15).padStart(2, "0")}`;

export function buildCurvePreview(
  rows: LedgerBucket[],
  holidays: HolidayEntry[],
  exclude: Set<string>,
  now: Date = new Date()
): CurvePreview {
  const today = istToday(now);
  const ctx = makeBaselineCtx(rows, holidays, today, exclude);
  const usual = typicalFor(ctx, today);
  const curve = ctx.curves.get(today);
  let lastSlot: number | null = null;
  curve?.forEach((v, k) => { if (v != null) lastSlot = k; });

  return {
    date: today,
    dayLabel: DAY_CLASS_LABELS[usual.dayClass],
    peers: usual.peers,
    minPeers: MIN_PEER_DAYS,
    enough: usual.peers >= MIN_PEER_DAYS,
    lastSlot,
    slots: Array.from({ length: 96 }, (_, k) => ({
      k,
      time: slotTime(k),
      typical: usual.typical[k] == null ? null : Math.round(usual.typical[k]! * 100) / 100,
      actual: curve && curve[k] != null ? Math.round(curve[k]! * 100) / 100 : null,
    })),
  };
}
