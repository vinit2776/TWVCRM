/**
 * Flow Guide System — static route → contextual hint mapping.
 *
 * Zero infrastructure: pure client-side idle detection + sessionStorage.
 * Add a new entry here to add a hint to any dashboard page.
 */

export type UserRole = "admin" | "manager" | "staff";

export interface FlowGuide {
  /** Unique key used for sessionStorage dismissal tracking */
  key: string;
  /** Display name shown in the hint card header */
  flowName: string;
  /** Current step in the flow (1-based) */
  step: number;
  /** Total number of steps in this flow */
  totalSteps: number;
  /** The hint text shown to the user */
  hint: string;
  /** Optional CTA button label */
  ctaLabel?: string;
  /** Optional CTA navigation href */
  ctaHref?: string;
  /** If set, only users with these roles will see this hint */
  roles?: UserRole[];
  /** Idle duration in ms before showing (default: 10 000) */
  idleMs?: number;
}

interface RouteEntry {
  pattern: string | RegExp;
  guide: FlowGuide;
}

export const ROUTE_GUIDES: RouteEntry[] = [
  // ── LEADS ──────────────────────────────────────────────────────────────────
  {
    pattern: "/leads",
    guide: {
      key: "leads-list",
      flowName: "Leads Pipeline",
      step: 1,
      totalSteps: 3,
      hint: "Every deal starts with a lead. Create one to kick off your sales flow.",
      ctaLabel: "New Lead",
      ctaHref: "/leads/new",
    },
  },
  {
    pattern: "/leads/new",
    guide: {
      key: "leads-new",
      flowName: "Creating a Lead",
      step: 1,
      totalSteps: 2,
      hint: "Fill in the contact details. Company name and phone number are the most useful fields to start.",
      idleMs: 15_000,
    },
  },
  {
    pattern: /^\/leads\/[^/]+(?:\/edit)?$/,
    guide: {
      key: "leads-detail",
      flowName: "Leads Pipeline",
      step: 2,
      totalSteps: 3,
      hint: "Lead saved! Once this lead is qualified, create a proposal to move the deal forward.",
      ctaLabel: "View Proposals",
      ctaHref: "/proposals",
    },
  },

  // ── PROPOSALS ─────────────────────────────────────────────────────────────
  {
    pattern: "/proposals",
    guide: {
      key: "proposals-list",
      flowName: "Proposal Flow",
      step: 1,
      totalSteps: 3,
      hint: "Proposals convert qualified leads into quoted deals. Open a proposal to add pricing and send it.",
    },
  },
  {
    pattern: /^\/proposals\/[^/]+$/,
    guide: {
      key: "proposals-detail",
      flowName: "Proposal Flow",
      step: 2,
      totalSteps: 3,
      hint: "Add line items to set pricing, then use Preview to review before sending to the client.",
      idleMs: 15_000,
    },
  },

  // ── CONTRACTS ─────────────────────────────────────────────────────────────
  {
    pattern: "/contracts",
    guide: {
      key: "contracts-list",
      flowName: "Contracts",
      step: 1,
      totalSteps: 2,
      hint: "Contracts are generated from accepted proposals. Open one to review the terms and activate it.",
    },
  },
  {
    pattern: /^\/contracts\/[^/]+$/,
    guide: {
      key: "contracts-detail",
      flowName: "Contracts",
      step: 2,
      totalSteps: 2,
      hint: "Activate this contract to start the membership. Billing will begin from the contract start date.",
      roles: ["admin", "manager"],
    },
  },

  // ── BOOKINGS ──────────────────────────────────────────────────────────────
  {
    pattern: "/bookings",
    guide: {
      key: "bookings-list",
      flowName: "Bookings",
      step: 1,
      totalSteps: 2,
      hint: "Book a space for a visitor or member. Use the filters to find available slots by date.",
      ctaLabel: "New Booking",
      ctaHref: "/bookings/new",
    },
  },
  {
    pattern: "/bookings/new",
    guide: {
      key: "bookings-new",
      flowName: "Creating a Booking",
      step: 2,
      totalSteps: 2,
      hint: "Select the space and time slot, then confirm. The client receives an auto-confirmation.",
      idleMs: 15_000,
    },
  },

  // ── ACCOUNTING ────────────────────────────────────────────────────────────
  {
    pattern: "/accounting",
    guide: {
      key: "accounting-overview",
      flowName: "Accounting",
      step: 1,
      totalSteps: 3,
      hint: "Select a billing period, verify payments are marked, then upload and send GST invoices to clients.",
      roles: ["admin", "manager"],
    },
  },

  // ── PROCUREMENT ───────────────────────────────────────────────────────────
  {
    pattern: "/procurement/requests",
    guide: {
      key: "procurement-requests",
      flowName: "Procurement Flow",
      step: 1,
      totalSteps: 3,
      hint: "Raise a purchase request here. A manager will review and approve it before an order is placed.",
      ctaLabel: "New Request",
      ctaHref: "/procurement/requests/new",
    },
  },
  {
    pattern: "/procurement/requests/new",
    guide: {
      key: "procurement-requests-new",
      flowName: "Raising a Request",
      step: 1,
      totalSteps: 2,
      hint: "Describe what you need, the quantity, and estimated cost. The more detail you add, the faster the approval.",
      idleMs: 15_000,
    },
  },
  {
    pattern: "/procurement/orders",
    guide: {
      key: "procurement-orders",
      flowName: "Procurement Flow",
      step: 2,
      totalSteps: 3,
      hint: "Place an order once a request is approved. The vendor receives a formal purchase order.",
      ctaLabel: "New Order",
      ctaHref: "/procurement/orders/new",
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: "/procurement/bills",
    guide: {
      key: "procurement-bills",
      flowName: "Procurement Flow",
      step: 3,
      totalSteps: 3,
      hint: "Record the vendor bill after goods are received. Attach the invoice PDF for future reference.",
      ctaLabel: "New Bill",
      ctaHref: "/procurement/bills/new",
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: "/procurement/bills/new",
    guide: {
      key: "procurement-bills-new",
      flowName: "Recording a Bill",
      step: 1,
      totalSteps: 2,
      hint: "Match this bill to its purchase order. Uploading the vendor invoice keeps your records clean.",
      idleMs: 15_000,
      roles: ["admin", "manager"],
    },
  },

  // ── PIPELINE ──────────────────────────────────────────────────────────────
  {
    pattern: "/pipeline",
    guide: {
      key: "pipeline",
      flowName: "Sales Pipeline",
      step: 1,
      totalSteps: 1,
      hint: "Drag lead cards between stages to update their status. Click any card to open the full lead detail.",
    },
  },

  // ── TASKS ─────────────────────────────────────────────────────────────────
  {
    pattern: "/tasks",
    guide: {
      key: "tasks",
      flowName: "Tasks",
      step: 1,
      totalSteps: 1,
      hint: "Tasks track follow-ups and reminders. Assign a due date and owner so nothing falls through.",
    },
  },

  // ── VOUCHERS ──────────────────────────────────────────────────────────────
  {
    pattern: "/vouchers",
    guide: {
      key: "vouchers",
      flowName: "Vouchers",
      step: 1,
      totalSteps: 1,
      hint: "Vouchers give members access to spaces. Set the validity period and seat count before issuing.",
      roles: ["admin", "manager"],
    },
  },

  // ── CASES ─────────────────────────────────────────────────────────────────
  {
    pattern: "/cases",
    guide: {
      key: "cases-list",
      flowName: "Cases",
      step: 1,
      totalSteps: 2,
      hint: "Cases track complex client situations that span multiple interactions. Open one to see the full timeline.",
      ctaLabel: "New Case",
      ctaHref: "/cases/new",
    },
  },

  // ── SUPPORT ───────────────────────────────────────────────────────────────
  {
    pattern: "/support",
    guide: {
      key: "support",
      flowName: "Support Tickets",
      step: 1,
      totalSteps: 1,
      hint: "Open a support ticket for any operational or technical issue. Add screenshots if it helps explain the problem.",
    },
  },

  // ── FACILITY ──────────────────────────────────────────────────────────────
  {
    pattern: "/facility/issues",
    guide: {
      key: "facility-issues",
      flowName: "Facility Issues",
      step: 1,
      totalSteps: 2,
      hint: "Log a facility issue to track maintenance and repair work. Assign it to the right team member.",
    },
  },

  // ── PETTY CASH ────────────────────────────────────────────────────────────
  {
    pattern: "/petty-cash",
    guide: {
      key: "petty-cash",
      flowName: "Petty Cash",
      step: 1,
      totalSteps: 1,
      hint: "Record small cash expenses here. Each entry needs a receipt category and amount.",
      roles: ["admin", "manager"],
    },
  },
];

/** Returns the guide for the current pathname, or null if none matches. */
export function findGuide(pathname: string): FlowGuide | null {
  for (const entry of ROUTE_GUIDES) {
    if (typeof entry.pattern === "string") {
      if (pathname === entry.pattern) return entry.guide;
    } else {
      if (entry.pattern.test(pathname)) return entry.guide;
    }
  }
  return null;
}
