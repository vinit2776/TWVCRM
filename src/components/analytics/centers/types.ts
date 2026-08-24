// Shapes returned by /api/analytics/centers/* — kept in one place since the
// page and every subcomponent below it read the same response shapes.

export interface DateRange {
  start: string;
  end: string;
}

export interface CenterSummary {
  location_id: string;
  location_name: string;
  sales: number;
  billed: number;
  collections: number;
  collection_efficiency_pct: number;
  occupied_seats: number;
  capacity: number;
  occupancy_pct: number;
}

export interface SummaryResponse {
  range: DateRange;
  as_of: string;
  centers: CenterSummary[];
}

export type TrendMetric = "sales" | "collections" | "occ";

export interface TrendPoint {
  month: string;
  value: number;
}

export interface TrendSeries {
  location_id: string;
  location_name: string;
  points: TrendPoint[];
}

export interface TrendResponse {
  metric: TrendMetric;
  months: number;
  centers: TrendSeries[];
}

export interface CenterDetail {
  location: { id: string; name: string };
  range: DateRange;
  pipeline: {
    active_leads: number;
    proposals_sent: number;
    contracts_signed: number;
  };
  aging: {
    not_due: number;
    d1_15: number;
    d16_30: number;
    d31_45: number;
    d45_plus: number;
  };
  rooms: Array<{ type: string; capacity: number; occupied: number }>;
  top_clients: Array<{ lead_id: string; name: string; billed: number }>;
}

export type BreakdownMetric = "sales" | "billed" | "collections";

export type BillingPaymentStatus = "unpaid" | "partially_paid" | "paid";

export interface BreakdownItem {
  id: string;
  reference: string;
  client_name: string;
  date: string;
  amount: number;
  href: string | null;
  /** Set only for "billed" items — the statement's current payment_status. */
  payment_status?: BillingPaymentStatus;
}

export interface BreakdownResponse {
  metric: BreakdownMetric;
  range: DateRange;
  total: number;
  items: BreakdownItem[];
}

export interface HeatmapUnit {
  unit_id: string;
  code: string;
  name: string;
  type: string;
  capacity: number;
  location_id: string;
  location_name: string;
  /** % of days in the selected range this unit had a live-contract allocation. */
  occupancy_pct: number;
  /** Current tenant's monthly-equivalent rate, capacity-apportioned — a snapshot, not range-based. */
  monthly_revenue: number;
  vacant_now: boolean;
  /** The contract currently occupying this unit — null when vacant. */
  contract_id: string | null;
}

export interface HeatmapResponse {
  range: DateRange;
  units: HeatmapUnit[];
}

export const ROOM_TYPE_LABELS: Record<string, string> = {
  hot_desk: "Hot Desk",
  dedicated_desk: "Dedicated Desk",
  private_cabin: "Private Cabin",
  managed_office: "Managed Office",
  business_centre: "Business Centre",
};

export interface ProjectionCenterSeries {
  location_id: string;
  location_name: string;
  /** 12 months, Apr-Mar — sum of active/renewal-in-progress contracts overlapping each month, at current phase rate. */
  confirmed: number[];
  /** 12 months — hypothetical revenue added back after a contract's own end_date, at its stored escalation %. */
  if_renewed: number[];
}

export interface ProjectionContractRow {
  id: string;
  location_id: string;
  location_name: string;
  client_name: string;
  monthly_rate: number;
  end_date: string | null;
  status: string;
  escalation_percentage: number;
  renewed_rate: number;
}

export interface ProjectionsResponse {
  fy: { year: number; label: string; is_current: boolean; start: string; end: string };
  /** 12 YYYY-MM month keys, Apr-Mar. */
  months: string[];
  centers: ProjectionCenterSeries[];
  contracts: ProjectionContractRow[];
}
