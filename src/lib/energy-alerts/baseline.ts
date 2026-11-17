// "Usual for this slot": the median kW of the same 15-minute slot over the last 30
// days of the same kind of day (Mon–Fri / Saturday / Sunday & holiday). It reuses the
// ledger helpers behind the Usage screen so an alert and that screen agree.

import { buildDayCurves, type DayCurve } from "@/lib/energy-peak";
import {
  aggregateDaily, addDays, classifyDay,
  type DailyUsage, type HolidayEntry, type LedgerBucket,
} from "@/lib/energy-baseline";
import { dayClassOf, type DayClass } from "@/lib/energy-today";

export const ALERT_BASELINE_DAYS = 30;
// Fewer comparable days than this and no alert is raised: not enough to know what usual is.
// There is deliberately NO fallback to other kinds of day: the "Today vs usual" chart compares a
// thin Saturday with weekdays, but an alert doing that fires all day on a normal Saturday.
export const MIN_PEER_DAYS = 3;
// A slot needs this many peer readings for its own median.
const MIN_SLOT_PEERS = 3;

export interface BaselineCtx {
  curves: Map<string, DayCurve>;
  daily: DailyUsage[];
  holidayMap: Map<string, string>;
  exclude: Set<string>;
}

export interface TypicalCurve {
  typical: (number | null)[];
  peers: number;
  dayClass: DayClass;
}

export function makeBaselineCtx(
  rows: LedgerBucket[],
  holidays: HolidayEntry[],
  today: string,
  exclude: Set<string> = new Set()
): BaselineCtx {
  return {
    curves: buildDayCurves(rows),
    daily: aggregateDaily(rows, holidays, today),
    holidayMap: new Map(holidays.map((h) => [h.date, h.name])),
    exclude,
  };
}

function median(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x != null).sort((a, b) => a - b);
  if (v.length < MIN_SLOT_PEERS) return null;
  const mid = (v.length - 1) / 2;
  return (v[Math.floor(mid)] + v[Math.ceil(mid)]) / 2;
}

/** The usual 96-slot kW curve for `date`, from days before it. Days in `exclude` (days that
 *  already had a real alert episode) are left out so a fault cannot drag "usual" up to meet itself. */
export function typicalFor(ctx: BaselineCtx, date: string): TypicalCurve {
  const from = addDays(date, -ALERT_BASELINE_DAYS);
  const to = addDays(date, -1);
  const dayClass = dayClassOf(date, classifyDay(date, ctx.holidayMap).dayType);
  const complete = ctx.daily.filter((d) => d.complete && d.date >= from && d.date <= to && !ctx.exclude.has(d.date));

  const peerDays = complete.filter((d) => dayClassOf(d.date, d.dayType) === dayClass);
  const peerCurves = peerDays.map((d) => ctx.curves.get(d.date)).filter((c): c is DayCurve => c != null);
  const typical: (number | null)[] = new Array(96).fill(null);
  if (peerCurves.length >= MIN_PEER_DAYS) {
    for (let k = 0; k < 96; k++) typical[k] = median(peerCurves.map((c) => c[k]));
  }
  return { typical, peers: peerCurves.length, dayClass };
}
