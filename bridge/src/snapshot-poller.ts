/**
 * Snapshot poller — added in bridge 1.4.0.
 *
 * Read-only sync-pull. Reads voucher + party data from Tally and POSTs it
 * to /api/tally/sync-pull on the CRM every ~30 min during business hours.
 *
 * Strictly additive — does not interact with the existing writer-poll
 * loop. If anything in here throws, the writer poller and heartbeat are
 * unaffected.
 *
 * Date window: current FY + previous month (handles year-end edge cases
 * where Tally vouchers can land in March/April overlapping FYs).
 *
 * Business hours: configurable via snapshot_business_hours in config.
 * Default 09:00-20:00 IST (Tally office hours per tally-handoff-redesign.md).
 * Outside hours, the poller sleeps — no point hammering Tally when it's off.
 */

import { Config } from "./config";
import { CrmClient } from "./crm-client";
import { TallyClient } from "./tally-client";
import { log } from "./logger";
import { randomUUID } from "crypto";

export interface SnapshotPollerOptions {
  /** How often to do a snapshot pull. Default 30 minutes. */
  intervalMs?: number;
  /** Business hours start (24h, IST). Default 9. */
  businessHourStart?: number;
  /** Business hours end (24h, IST). Default 20. */
  businessHourEnd?: number;
}

export class SnapshotPoller {
  private readonly crm: CrmClient;
  private readonly tally: TallyClient;
  private readonly company: string;
  private readonly intervalMs: number;
  private readonly hourStart: number;
  private readonly hourEnd: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(args: { crm: CrmClient; tally: TallyClient; config: Config; options?: SnapshotPollerOptions }) {
    this.crm = args.crm;
    this.tally = args.tally;
    this.company = args.config.tally_target_company;
    this.intervalMs = args.options?.intervalMs ?? 30 * 60 * 1000;
    this.hourStart = args.options?.businessHourStart ?? 9;
    this.hourEnd = args.options?.businessHourEnd ?? 20;
  }

  start(): void {
    log.info(`[snapshot] starting — interval ${Math.round(this.intervalMs / 60000)}min, business hours ${this.hourStart}-${this.hourEnd} IST`);
    // First pull happens after ~15s warmup so we don't compete with the
    // writer poller's startup activity. After that, regular cadence.
    this.timer = setTimeout(() => void this.tick(), 15_000);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => void this.tick(), this.intervalMs);
  }

  /** True if the current wall-clock IST hour is inside business hours. */
  private isBusinessHours(): boolean {
    const istHour = (new Date().getUTCHours() + 5) % 24; // crude IST offset; minutes don't matter for hour check
    return istHour >= this.hourStart && istHour < this.hourEnd;
  }

  private async tick(): Promise<void> {
    if (this.running) {
      // Prior tick still in flight; skip and reschedule
      this.scheduleNext();
      return;
    }
    if (!this.isBusinessHours()) {
      this.scheduleNext();
      return;
    }
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      log.warn(`[snapshot] cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }

  /** Public so the tray UI / a CLI flag can trigger a one-shot pull. */
  async runOnce(): Promise<{ accepted: number; matched: number; unmatched: number; auto_completed: number; parties: number }> {
    const { fromDate, toDate } = this.computeDateWindow();
    log.info(`[snapshot] starting pull · window ${fromDate} → ${toDate}`);

    const t0 = Date.now();

    // Read voucher list
    const rawVouchers = await this.tally.listVouchersForSnapshot(fromDate, toDate);
    // Filter out vouchers we don't know how to classify (cash sales, journal, etc.)
    const vouchers = rawVouchers.filter((v): v is typeof v & { voucher_kind: "sales" | "receipt" | "credit_note" } => v.voucher_kind !== null);

    // Read party master
    let parties: Awaited<ReturnType<TallyClient["listSundryDebtors"]>> = [];
    try {
      parties = await this.tally.listSundryDebtors();
    } catch (err) {
      // Party master read can fail in older Tally versions without TDL
      // support; treat as non-fatal — voucher snapshot is the load-bearing
      // half of this feature.
      log.warn(`[snapshot] party master read failed (continuing without): ${err instanceof Error ? err.message : String(err)}`);
    }

    const tReads = Date.now();
    log.info(`[snapshot] read ${vouchers.length} vouchers + ${parties.length} parties from Tally in ${tReads - t0}ms`);

    if (vouchers.length === 0 && parties.length === 0) {
      log.info("[snapshot] nothing to post — skipping CRM call");
      return { accepted: 0, matched: 0, unmatched: 0, auto_completed: 0, parties: 0 };
    }

    // POST to CRM
    const sync_batch_id = randomUUID();
    const result = await this.crm.postSyncPull(
      { sync_batch_id, company_name: this.company, vouchers, parties },
      this.company,
    );

    const tPost = Date.now();
    log.info(
      `[snapshot] cycle done in ${tPost - t0}ms · ` +
      `accepted=${result.accepted} matched=${result.matched} unmatched=${result.unmatched} auto_completed=${result.auto_completed}`,
    );

    return { ...result, parties: parties.length };
  }

  /**
   * Date window: previous calendar month start through today. Two months of
   * data is enough to:
   *   - Catch newly-created vouchers for current month (the load-bearing case)
   *   - Pick up backdated receipts (accounts sometimes dates a receipt to
   *     the day the customer transferred, which can be a few days back)
   *   - Span FY boundaries cleanly (Indian FY ends Mar 31)
   *
   * Two months is also small enough that the Day Book export stays fast.
   */
  private computeDateWindow(): { fromDate: string; toDate: string } {
    const now = new Date();
    const fromDate = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
    const toDate = now.toISOString().slice(0, 10);
    return { fromDate, toDate };
  }
}
