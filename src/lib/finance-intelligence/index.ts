/**
 * Finance Intelligence — barrel export.
 *
 * Phase 1 (foundation):
 *   • settings    — config loader + feature toggles + lookback window
 *   • suggest     — generic "learn from history" helpers (most-frequent,
 *                   averages, vendor history fetch, net-days computation)
 *   • anomaly     — statistical outlier detection
 *   • fuzzy-match — Levenshtein + similarity for duplicate-invoice detection
 *   • audit       — finance_suggestion_log writers
 *
 * Subsequent features each ship as a thin wrapper using these primitives
 * (e.g. duplicate-detector imports fuzzy-match + audit).
 */

export * from "./settings";
export * from "./suggest";
export * from "./anomaly";
export * from "./fuzzy-match";
export * from "./audit";
export * from "./vendor-email-nag";
