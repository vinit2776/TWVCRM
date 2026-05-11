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
  // ── DASHBOARD ─────────────────────────────────────────────────────────────
  {
    pattern: "/dashboard",
    guide: {
      key: "dashboard-home",
      flowName: "Dashboard",
      step: 1,
      totalSteps: 1,
      hint: "Your command centre. KPI cards, today's schedule, and renewal alerts — all filtered by the location selector at the top.",
    },
  },

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
    pattern: "/contracts/kyc-pending",
    guide: {
      key: "contracts-kyc",
      flowName: "KYC Compliance",
      step: 1,
      totalSteps: 1,
      hint: "Shows every contract with missing or deferred KYC documents. Clear items here or open the contract to upload docs.",
      roles: ["admin", "manager"],
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
      totalSteps: 3,
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
      totalSteps: 3,
      hint: "Select the space and time slot, then confirm. The client receives an auto-confirmation.",
      idleMs: 15_000,
    },
  },
  {
    pattern: /^\/bookings\/[^/]+$/,
    guide: {
      key: "bookings-detail",
      flowName: "Bookings",
      step: 3,
      totalSteps: 3,
      hint: "Review booking details, mark check-in/check-out, or cancel. Use the Actions menu for no-show or reschedule.",
      idleMs: 12_000,
    },
  },

  // ── BILLING ───────────────────────────────────────────────────────────────
  {
    pattern: "/billing",
    guide: {
      key: "billing",
      flowName: "Monthly Billing",
      step: 1,
      totalSteps: 1,
      hint: "Monthly billing statements for each contract. Generate a statement, add charges, mark payments, then lock it.",
      roles: ["admin", "manager"],
    },
  },

  // ── INVOICES ──────────────────────────────────────────────────────────────
  {
    pattern: "/invoices",
    guide: {
      key: "invoices",
      flowName: "Invoices",
      step: 1,
      totalSteps: 1,
      hint: "Proforma invoices sent to leads and prospects. Track status from draft → sent → paid or overdue.",
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
  {
    pattern: "/accounting/vendor-email-audit",
    guide: {
      key: "accounting-vendor-email",
      flowName: "Accounting",
      step: 2,
      totalSteps: 3,
      hint: "Flags vendors whose email bounced or is missing. Fix emails here so payment advice reaches the right inbox.",
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: /^\/accounting\/vendor-payments\/[^/]+$/,
    guide: {
      key: "accounting-vendor-payment",
      flowName: "Accounting",
      step: 3,
      totalSteps: 3,
      hint: "Review this vendor payment. Match it to the bill and confirm the amount before marking it as paid.",
      roles: ["admin", "manager"],
    },
  },

  // ── PROCUREMENT ───────────────────────────────────────────────────────────
  {
    pattern: "/procurement",
    guide: {
      key: "procurement-dashboard",
      flowName: "Procurement Hub",
      step: 1,
      totalSteps: 1,
      hint: "Quick snapshot of pending requests, open orders, and overdue bills. Click any card to jump to that section.",
      roles: ["admin", "manager"],
    },
  },
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
    pattern: /^\/procurement\/requests\/[^/]+$/,
    guide: {
      key: "procurement-request-detail",
      flowName: "Raising a Request",
      step: 2,
      totalSteps: 2,
      hint: "Review request details and approval status. Once approved, convert it to a purchase order.",
      idleMs: 12_000,
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
    pattern: "/procurement/orders/new",
    guide: {
      key: "procurement-orders-new",
      flowName: "Creating an Order",
      step: 1,
      totalSteps: 2,
      hint: "Select the vendor, add line items from the catalog, and set the expected delivery date.",
      idleMs: 15_000,
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: "/procurement/orders/new-service",
    guide: {
      key: "procurement-service-order",
      flowName: "Service Order",
      step: 1,
      totalSteps: 1,
      hint: "Service orders are for non-material purchases like AMC renewals or one-time services.",
      idleMs: 15_000,
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: /^\/procurement\/orders\/[^/]+$/,
    guide: {
      key: "procurement-order-detail",
      flowName: "Creating an Order",
      step: 2,
      totalSteps: 2,
      hint: "Track delivery status and record goods received. Once fulfilled, create a vendor bill to complete the cycle.",
      idleMs: 12_000,
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
  {
    pattern: /^\/procurement\/bills\/[^/]+$/,
    guide: {
      key: "procurement-bill-detail",
      flowName: "Recording a Bill",
      step: 2,
      totalSteps: 2,
      hint: "Verify the bill amount matches the order. Mark payment once the vendor has been paid.",
      idleMs: 12_000,
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: "/procurement/catalog",
    guide: {
      key: "procurement-catalog",
      flowName: "Product Catalog",
      step: 1,
      totalSteps: 1,
      hint: "Master list of items you buy regularly. Set reorder levels here so low-stock alerts trigger automatically.",
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: /^\/procurement\/catalog\/[^/]+$/,
    guide: {
      key: "procurement-catalog-detail",
      flowName: "Catalog Item",
      step: 1,
      totalSteps: 1,
      hint: "Edit item details, pricing, preferred vendor, and reorder threshold. Changes reflect in future purchase orders.",
      idleMs: 12_000,
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: "/procurement/inventory",
    guide: {
      key: "procurement-inventory",
      flowName: "Inventory",
      step: 1,
      totalSteps: 1,
      hint: "Current stock levels across all locations. Items below reorder level are highlighted for quick action.",
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: "/procurement/consumption",
    guide: {
      key: "procurement-consumption",
      flowName: "Consumption",
      step: 1,
      totalSteps: 2,
      hint: "Record daily consumption of stocked items. This reduces inventory and feeds the reorder alerts.",
    },
  },
  {
    pattern: "/procurement/consumption/history",
    guide: {
      key: "procurement-consumption-history",
      flowName: "Consumption",
      step: 2,
      totalSteps: 2,
      hint: "Historical view of all consumption entries. Use the date filter to spot trends and unusual spikes.",
    },
  },
  {
    pattern: "/procurement/payables",
    guide: {
      key: "procurement-payables",
      flowName: "Vendor Payables",
      step: 1,
      totalSteps: 1,
      hint: "Outstanding vendor payments grouped by due date. Pay here or record a manual bank transfer.",
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: "/procurement/vendors",
    guide: {
      key: "procurement-vendors",
      flowName: "Vendors",
      step: 1,
      totalSteps: 2,
      hint: "Manage your supplier directory. Add a vendor before you can place orders with them.",
      ctaLabel: "Add Vendor",
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: /^\/procurement\/vendors\/[^/]+$/,
    guide: {
      key: "procurement-vendor-detail",
      flowName: "Vendors",
      step: 2,
      totalSteps: 2,
      hint: "Vendor profile with contact info, GST details, and order history. Upload compliance documents in the Files tab.",
      idleMs: 12_000,
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: "/procurement/transfers",
    guide: {
      key: "procurement-transfers",
      flowName: "Stock Transfers",
      step: 1,
      totalSteps: 2,
      hint: "Move inventory between locations. Both the sending and receiving location see the transfer for confirmation.",
      ctaLabel: "New Transfer",
      ctaHref: "/procurement/transfers/new",
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: "/procurement/transfers/new",
    guide: {
      key: "procurement-transfers-new",
      flowName: "Stock Transfers",
      step: 2,
      totalSteps: 2,
      hint: "Select source and destination locations, then pick items and quantities. The receiving site confirms on arrival.",
      idleMs: 15_000,
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: /^\/procurement\/transfers\/[^/]+$/,
    guide: {
      key: "procurement-transfer-detail",
      flowName: "Transfer Detail",
      step: 1,
      totalSteps: 1,
      hint: "Review transfer items and status. The receiving location marks items as received to complete the transfer.",
      idleMs: 12_000,
    },
  },
  {
    pattern: "/procurement/verify",
    guide: {
      key: "procurement-verify",
      flowName: "Approvals",
      step: 1,
      totalSteps: 1,
      hint: "Pending approvals for purchase requests, vendor bills, and stock transfers. Review and approve or reject each item.",
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: "/procurement/amc",
    guide: {
      key: "procurement-amc",
      flowName: "AMC Tracking",
      step: 1,
      totalSteps: 1,
      hint: "Annual Maintenance Contracts for equipment and services. Track expiry dates so renewals don't slip.",
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

  // ── ACTIVITIES ────────────────────────────────────────────────────────────
  {
    pattern: "/activities",
    guide: {
      key: "activities",
      flowName: "Activity Log",
      step: 1,
      totalSteps: 1,
      hint: "All calls, meetings, emails, and site visits logged by the team. Filter by type or date to find specific interactions.",
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
      totalSteps: 3,
      hint: "Cases track complex client situations that span multiple interactions. Open one to see the full timeline.",
      ctaLabel: "New Case",
      ctaHref: "/cases/new",
    },
  },
  {
    pattern: "/cases/new",
    guide: {
      key: "cases-new",
      flowName: "Cases",
      step: 2,
      totalSteps: 3,
      hint: "Link this case to a lead or contract, set the priority, and describe the situation clearly for the team.",
      idleMs: 15_000,
    },
  },
  {
    pattern: /^\/cases\/[^/]+$/,
    guide: {
      key: "cases-detail",
      flowName: "Cases",
      step: 3,
      totalSteps: 3,
      hint: "Full case timeline with notes and attachments. Add updates as the situation evolves, then resolve when done.",
      idleMs: 12_000,
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

  // ── MY TICKETS ────────────────────────────────────────────────────────────
  {
    pattern: "/my-tickets",
    guide: {
      key: "my-tickets",
      flowName: "My Tickets",
      step: 1,
      totalSteps: 1,
      hint: "Tickets assigned to you. Update the status as you work through each item — the requester sees your progress.",
    },
  },

  // ── FACILITY ──────────────────────────────────────────────────────────────
  {
    pattern: "/facility",
    guide: {
      key: "facility-dashboard",
      flowName: "Facility Management",
      step: 1,
      totalSteps: 4,
      hint: "Facility analytics: open issues, resolution times, and SLA compliance. Use the sidebar to drill into specific areas.",
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: "/facility/issues",
    guide: {
      key: "facility-issues",
      flowName: "Facility Management",
      step: 2,
      totalSteps: 4,
      hint: "Log a facility issue to track maintenance and repair work. Assign it to the right team member.",
    },
  },
  {
    pattern: /^\/facility\/issues\/[^/]+$/,
    guide: {
      key: "facility-issue-detail",
      flowName: "Issue Tracking",
      step: 1,
      totalSteps: 1,
      hint: "Update status, add notes, and attach photos. The issue owner gets notified of every change.",
      idleMs: 12_000,
    },
  },
  {
    pattern: "/facility/my-issues",
    guide: {
      key: "facility-my-issues",
      flowName: "Facility Management",
      step: 3,
      totalSteps: 4,
      hint: "Your assigned issues. Tap any card to update progress. Resolve items promptly — your KPI tracks response time.",
    },
  },
  {
    pattern: "/facility/assets",
    guide: {
      key: "facility-assets",
      flowName: "Asset Register",
      step: 1,
      totalSteps: 2,
      hint: "All physical assets (printers, ACs, furniture) across locations. Add assets to track warranty and service history.",
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: /^\/facility\/assets\/[^/]+$/,
    guide: {
      key: "facility-asset-detail",
      flowName: "Asset Register",
      step: 2,
      totalSteps: 2,
      hint: "Asset details, service history, and warranty info. Link maintenance issues to this asset for a complete repair log.",
      idleMs: 12_000,
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: "/facility/team-kpi",
    guide: {
      key: "facility-team-kpi",
      flowName: "Facility Management",
      step: 4,
      totalSteps: 4,
      hint: "Per-technician metrics: resolution rate, average response time, and SLA compliance. Export to CSV for appraisals.",
      roles: ["admin", "manager"],
    },
  },

  // ── SPACES ────────────────────────────────────────────────────────────────
  {
    pattern: "/spaces",
    guide: {
      key: "spaces-list",
      flowName: "Spaces",
      step: 1,
      totalSteps: 2,
      hint: "Meeting rooms, conference halls, and bookable areas. Set capacity, pricing, and facilities for each space.",
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: /^\/spaces\/[^/]+$/,
    guide: {
      key: "spaces-detail",
      flowName: "Spaces",
      step: 2,
      totalSteps: 2,
      hint: "Edit this space's pricing, photos, and available facilities. Changes apply to all future bookings.",
      idleMs: 12_000,
      roles: ["admin", "manager"],
    },
  },

  // ── LOCATIONS ─────────────────────────────────────────────────────────────
  {
    pattern: "/locations",
    guide: {
      key: "locations-list",
      flowName: "Locations",
      step: 1,
      totalSteps: 2,
      hint: "Your coworking centres. Each location has its own spaces, contracts, and billing. Click a row to see details.",
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: /^\/locations\/[^/]+$/,
    guide: {
      key: "locations-detail",
      flowName: "Locations",
      step: 2,
      totalSteps: 2,
      hint: "Location overview, floor plans, and space analytics. Use the Spaces tab to manage units on each floor.",
      idleMs: 12_000,
      roles: ["admin", "manager"],
    },
  },

  // ── PACKAGES ──────────────────────────────────────────────────────────────
  {
    pattern: "/packages",
    guide: {
      key: "packages",
      flowName: "Prepaid Packages",
      step: 1,
      totalSteps: 1,
      hint: "Create prepaid credit packages (hours or day passes) and sell them to members. Credits are deducted at booking time.",
      roles: ["admin", "manager"],
    },
  },

  // ── AGGREGATORS ───────────────────────────────────────────────────────────
  {
    pattern: "/aggregators",
    guide: {
      key: "aggregators-list",
      flowName: "Aggregators",
      step: 1,
      totalSteps: 3,
      hint: "Channel partners who bring in bookings. Track commission rates and rate cards for each aggregator.",
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: "/aggregators/new",
    guide: {
      key: "aggregators-new",
      flowName: "Aggregators",
      step: 2,
      totalSteps: 3,
      hint: "Add the aggregator's company details, GST info, and commission percentage. Rate cards can be added after creation.",
      idleMs: 15_000,
      roles: ["admin", "manager"],
    },
  },
  {
    pattern: /^\/aggregators\/[^/]+$/,
    guide: {
      key: "aggregators-detail",
      flowName: "Aggregators",
      step: 3,
      totalSteps: 3,
      hint: "Manage contacts and rate cards for this aggregator. Rate cards define per-space pricing used in invoices.",
      idleMs: 12_000,
      roles: ["admin", "manager"],
    },
  },

  // ── DOCUMENTS ─────────────────────────────────────────────────────────────
  {
    pattern: "/documents",
    guide: {
      key: "documents",
      flowName: "Documents",
      step: 1,
      totalSteps: 1,
      hint: "Uploaded files attached to leads, contracts, and bills. Use the search to find any document by name or type.",
    },
  },

  // ── HEADCOUNT ─────────────────────────────────────────────────────────────
  {
    pattern: "/headcount",
    guide: {
      key: "headcount",
      flowName: "Headcount",
      step: 1,
      totalSteps: 1,
      hint: "Daily headcount by area type and location. Log actual occupancy to track utilisation against capacity.",
      roles: ["admin", "manager"],
    },
  },

  // ── ATTENDANCE ────────────────────────────────────────────────────────────
  {
    pattern: "/attendance",
    guide: {
      key: "attendance",
      flowName: "Attendance",
      step: 1,
      totalSteps: 1,
      hint: "Biometric device dashboard. See registered devices, live punches, and map device PINs to CRM members.",
      roles: ["admin", "manager"],
    },
  },

  // ── TEAM ──────────────────────────────────────────────────────────────────
  {
    pattern: "/team",
    guide: {
      key: "team",
      flowName: "Team Management",
      step: 1,
      totalSteps: 1,
      hint: "Manage staff accounts, assign roles (admin / manager / staff), and control which locations each person can access.",
      roles: ["admin"],
    },
  },

  // ── SETTINGS ──────────────────────────────────────────────────────────────
  {
    pattern: "/settings",
    guide: {
      key: "settings",
      flowName: "Settings",
      step: 1,
      totalSteps: 1,
      hint: "Your profile, notification preferences, and system configuration. Admins can configure payment gateways and budgets here.",
    },
  },

  // ── AUDIT LOGS ────────────────────────────────────────────────────────────
  {
    pattern: "/audit-logs",
    guide: {
      key: "audit-logs",
      flowName: "Audit Logs",
      step: 1,
      totalSteps: 1,
      hint: "Every create, update, and delete action in the system. Filter by user or entity type to investigate changes.",
      roles: ["admin"],
    },
  },

  // ── INFRASTRUCTURE ────────────────────────────────────────────────────────
  {
    pattern: "/infrastructure",
    guide: {
      key: "infrastructure",
      flowName: "Infrastructure",
      step: 1,
      totalSteps: 1,
      hint: "System health dashboard: database size, storage usage, email quota, and API limits. Refresh to see live stats.",
      roles: ["admin"],
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

  // ── ADMIN: DEPT IDS ───────────────────────────────────────────────────────
  {
    pattern: "/admin/dept-ids",
    guide: {
      key: "admin-dept-ids",
      flowName: "Department IDs",
      step: 1,
      totalSteps: 1,
      hint: "Bulk-assign printer department IDs to contracts. IDs are unique per location. Tab through rows, edit, and auto-save on blur.",
      roles: ["admin", "manager"],
    },
  },

  // ── HELP ──────────────────────────────────────────────────────────────────
  {
    pattern: "/help",
    guide: {
      key: "help",
      flowName: "Help Centre",
      step: 1,
      totalSteps: 1,
      hint: "Searchable documentation for every module. Browse workflows, FAQs, and keyboard shortcuts all in one place.",
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
