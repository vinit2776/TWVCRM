import type {
  Journey,
  JourneyInput,
  JourneyOwner,
  JourneyPhase,
  JourneyStep,
} from "./types";

interface Draft {
  key: string;
  label: string;
  owner: JourneyOwner;
  done: boolean;
  optional?: boolean;
  /** When set (and the step isn't done) the step is shown as blocked with this reason. */
  blockedBy?: string | null;
  hint?: string;
  detail?: string;
  href?: string;
  ctaLabel?: string;
  action?: JourneyStep["action"];
}

interface PhaseDraft {
  key: string;
  title: string;
  steps: Draft[];
}

// Phases whose steps don't depend on each other once nothing blocks them, so
// several owners can work in parallel (e.g. IT issues vouchers while ops adds members).
const PARALLEL_PHASES = new Set(["onboard", "bill"]);

const PROPOSAL_SENT_STATUSES = ["sent", "viewed", "accepted"];
// Statuses from which the agreement has been accepted (or the contract has moved on).
const CONTRACT_ACCEPTED_STATUSES = ["accepted", "active", "renewal_in_progress", "renewed", "expired"];

function buildDrafts(input: JourneyInput): PhaseDraft[] {
  const { leadId, leadStatus, enquiry, proposal, contract } = input;
  const leadHref = `/leads/${leadId}`;
  const proposalsTab = `${leadHref}?tab=proposals`;
  const proposalHref = proposal ? `/proposals/${proposal.id}` : proposalsTab;
  const contractHref = contract ? `/contracts/${contract.id}` : `${leadHref}?tab=contracts`;
  const isRenewal = !!contract?.isRenewal;

  const phases: PhaseDraft[] = [];

  if (!isRenewal) {
    const sales: Draft[] = [];
    if (enquiry) {
      sales.push({
        key: "enquiry_claimed",
        label: "Enquiry claimed by a team member",
        owner: "sales",
        done: enquiry.claimed || enquiry.resolved || leadStatus !== "new" || !!proposal,
        href: "/leads/enquiry-log",
        ctaLabel: "Open enquiry log",
      });
    }
    sales.push(
      {
        key: "first_contact",
        label: "First contact logged",
        owner: "sales",
        done: leadStatus !== "new" || !!proposal,
        hint: "Log a call, note or WhatsApp on the lead.",
        href: `${leadHref}?tab=activities`,
        ctaLabel: "Log activity",
      },
      {
        key: "tour",
        label: "Tour done",
        owner: "sales",
        optional: true,
        done: ["tour_completed", "proposal_sent", "negotiating", "won"].includes(leadStatus),
        href: `${leadHref}?tab=activities`,
        ctaLabel: "Schedule tour",
      },
    );
    phases.push({ key: "lead", title: "Enquiry and lead", steps: sales });

    const rejected = proposal?.status === "rejected";
    const needsWaiver = !!proposal && proposal.depositMonths <= 0 && !proposal.waiverVerified;
    phases.push({
      key: "proposal",
      title: "Proposal",
      steps: [
        {
          key: "proposal_drafted",
          label: "Proposal drafted with seats, rate, deposit and terms",
          owner: "sales",
          done: !!proposal,
          href: proposalsTab,
          ctaLabel: "Create proposal",
        },
        {
          key: "proposal_sent",
          label: "Proposal sent to the customer",
          owner: "sales",
          done: !!proposal && PROPOSAL_SENT_STATUSES.includes(proposal.status),
          blockedBy: !proposal
            ? null
            : rejected
              ? "The customer rejected this proposal. Create a revised proposal."
              : needsWaiver
                ? "Zero deposit: an admin must approve the deposit waiver before it can be emailed."
                : null,
          href: proposalHref,
          ctaLabel: "Send proposal",
        },
        {
          key: "proposal_accepted",
          label: "Customer accepts the proposal",
          owner: "sales",
          done: proposal?.status === "accepted",
          hint: "Marks that the customer said yes. Payment is collected in the next phase.",
          href: proposalHref,
          ctaLabel: "Mark accepted",
        },
      ],
    });

    const depositRequired = !!proposal && proposal.depositMonths > 0;
    const depositPaid = proposal?.depositStatus === "paid";
    const prorataPaid = proposal?.paymentStatus === "paid";
    const moneySteps: Draft[] = [];
    if (depositRequired) {
      moneySteps.push({
        key: "deposit_paid",
        label: "Security deposit received",
        owner: "accounts",
        done: depositPaid,
        hint: "Send the deposit request. If the customer paid by bank transfer, use Report paid so accounts can verify it.",
        href: proposalHref,
        ctaLabel: "Open proposal",
      });
    }
    moneySteps.push(
      {
        key: "prorata_sent",
        label: "Start date set and pro-rata invoice sent",
        owner: "sales",
        done: !!proposal && (proposal.prorataInvoiceSent || prorataPaid),
        blockedBy:
          proposal && depositRequired && !depositPaid
            ? "The pro-rata invoice can only be sent after the deposit is paid."
            : null,
        href: proposalHref,
        ctaLabel: "Send GST invoice",
      },
      {
        key: "prorata_paid",
        label: "Pro-rata payment received",
        owner: "accounts",
        done: prorataPaid,
        hint: "Customer pays the link, or accounts records a bank payment.",
        href: proposalHref,
        ctaLabel: "Open proposal",
      },
    );
    phases.push({ key: "money", title: "Collect money", steps: moneySteps });
  }

  // ── Contract and signing ───────────────────────────────────────────────
  const proposalReady =
    !proposal ||
    (proposal.status === "accepted" &&
      (proposal.depositMonths <= 0 || proposal.depositStatus === "paid"));
  const kycDone = !!contract && contract.kycTotal > 0 && contract.kycOutstanding === 0;
  const signed = !!contract?.signedDocumentId;
  const accepted = !!contract && CONTRACT_ACCEPTED_STATUSES.includes(contract.status);

  phases.push({
    key: "contract",
    title: "Contract and signing",
    steps: [
      {
        key: "contract_created",
        label: "Contract created from the proposal",
        owner: "sales",
        done: !!contract,
        blockedBy: !proposalReady ? "The proposal must be accepted and its deposit paid first." : null,
        href: proposal ? proposalHref : `${leadHref}?tab=contracts`,
        ctaLabel: "Create contract",
      },
      {
        key: "kyc",
        label: "KYC documents received",
        owner: "sales",
        done: kycDone,
        detail: contract && contract.kycTotal > 0 ? `${contract.kycTotal - contract.kycOutstanding} of ${contract.kycTotal}` : undefined,
        hint: contract && contract.kycTotal === 0 ? "No KYC checklist yet. Open the contract's Documents section." : "Does not block activation; the customer can defer with a date.",
        href: contractHref,
        ctaLabel: "Open KYC",
      },
      {
        key: "signed_copy",
        label: "Customer-signed agreement uploaded",
        owner: "sales",
        done: signed,
        hint: contract?.activated
          ? "WiFi vouchers stay blocked until it is attached."
          : "Activation is allowed without it, but WiFi vouchers stay blocked until it is attached.",
        href: contractHref,
        ctaLabel: "Upload signed copy",
      },
      {
        key: "stamped",
        label: "Company stamp and seal applied",
        owner: "admin",
        done: !!contract?.stamped,
        blockedBy: contract && !signed ? "Upload the customer-signed copy first." : null,
        href: contractHref,
        ctaLabel: "Stamp document",
      },
      {
        key: "contract_accepted",
        label: "Contract marked accepted",
        owner: "manager",
        done: accepted,
        href: contractHref,
        ctaLabel: "Mark accepted",
      },
    ],
  });

  // ── Activate ───────────────────────────────────────────────────────────
  phases.push({
    key: "activate",
    title: "Activate",
    steps: [
      {
        key: "seats_assigned",
        label: "Seats assigned to desks",
        owner: "ops",
        done: !!contract && contract.seats > 0 && contract.spacesAllocated >= contract.seats,
        detail: contract ? `${contract.spacesAllocated} of ${contract.seats}` : undefined,
        hint: "A warning at activation, not a hard block.",
        href: contractHref,
        ctaLabel: "Assign seats",
      },
      {
        key: "activated",
        label: "Contract activated",
        owner: "manager",
        done: !!contract?.activated,
        blockedBy: contract && !accepted ? "Mark the contract accepted first." : null,
        href: contractHref,
        ctaLabel: "Activate",
      },
    ],
  });

  // ── Get the customer in ────────────────────────────────────────────────
  const activated = !!contract?.activated;
  const members = contract?.members ?? 0;
  const wifiDone =
    !!contract &&
    (contract.hasContractLevelVoucher || (contract.vouchersActive > 0 && contract.vouchersActive >= members));
  const inSteps: Draft[] = [
    {
      key: "members_added",
      label: "Members added",
      owner: "ops",
      done: members > 0,
      detail: contract ? `${members} of ${contract.seats} seats` : undefined,
      blockedBy: contract && !activated ? "Activate the contract first." : null,
      href: contractHref,
      ctaLabel: "Add members",
    },
    {
      key: "wifi_vouchers",
      label: "WiFi vouchers issued",
      owner: "it",
      done: wifiDone,
      detail: contract && !contract.hasContractLevelVoucher ? `${contract.vouchersActive} of ${members}` : undefined,
      blockedBy: !contract
        ? null
        : !activated
          ? "Activate the contract first."
          : !signed
            ? "The signed agreement must be attached before vouchers can be issued."
            : null,
      href: contractHref,
      ctaLabel: "Issue vouchers",
    },
  ];
  // A location with no entry-point door controller never provisions access, so
  // the step would sit pending forever. Leave it out rather than show a false gap.
  if (!contract || contract.accessDevices > 0) {
    inSteps.push({
      key: "door_access",
      label: "Door access enrolled (PIN or card)",
      owner: "it",
      done: !!contract && members > 0 && contract.membersWithAccess >= members,
      detail: contract ? `${contract.membersWithAccess} of ${members}` : undefined,
      blockedBy: contract && !activated ? "Activate the contract first." : members === 0 && contract ? "Add members first." : null,
      href: contractHref,
      ctaLabel: "Enrol access",
    });
  }
  const doorApplicable = !contract || contract.accessDevices > 0;
  const doorDone = !!contract && members > 0 && contract.membersWithAccess >= members;
  inSteps.push({
    key: "welcome_done",
    label: "Customer welcomed",
    owner: "ops",
    done: !!contract?.welcomeDone,
    hint: "Confirm the customer has been welcomed and has their access. Nothing is sent to the customer.",
    blockedBy: !contract
      ? null
      : !activated
        ? "Activate the contract first."
        : !wifiDone
          ? "WiFi vouchers must be issued first."
          : doorApplicable && !doorDone
            ? "Door access must be enrolled first."
            : null,
    href: contractHref,
    ctaLabel: "Mark welcome done",
    action: "mark_welcome_done",
  });
  phases.push({ key: "onboard", title: "Get the customer in", steps: inSteps });

  phases.push({
    key: "bill",
    title: "First bill",
    steps: [
      {
        key: "first_proforma",
        label: "First rent proforma generated",
        owner: "accounts",
        done: !!contract?.rentStatementExists,
        hint: "Activation does not raise an invoice. Generate it from Billing or the contract's Invoices card.",
        blockedBy: contract && !activated ? "Activate the contract first." : null,
        href: contract ? contractHref : "/billing",
        ctaLabel: "Generate proforma",
      },
    ],
  });

  return phases;
}

export function computeJourney(input: JourneyInput): Journey {
  const drafts = buildDrafts(input);

  // The current step is the first required step that is not done.
  let currentKey: string | null = null;
  for (const phase of drafts) {
    for (const d of phase.steps) {
      if (!d.done && !d.optional) {
        currentKey = d.key;
        break;
      }
    }
    if (currentKey) break;
  }

  let nextStep: JourneyStep | null = null;
  const phases: JourneyPhase[] = drafts.map((phase) => {
    const steps: JourneyStep[] = phase.steps.map((d) => {
      let state: JourneyStep["state"];
      if (d.done) state = "done";
      else if (d.optional) state = "optional";
      else if (d.blockedBy) state = "blocked";
      else if (d.key === currentKey) state = "current";
      else state = "upcoming";

      const step: JourneyStep = {
        key: d.key,
        phase: phase.key,
        label: d.label,
        owner: d.owner,
        state,
        hint: !d.done && d.blockedBy ? d.blockedBy : d.hint,
        detail: d.detail,
        href: d.href,
        ctaLabel: d.ctaLabel,
        action: d.action,
        actionable: state === "current" || (state === "upcoming" && PARALLEL_PHASES.has(phase.key)),
      };
      if (d.key === currentKey) nextStep = step;
      return step;
    });
    const reqSteps = phase.steps.filter((d) => !d.optional);
    const requiredDone = reqSteps.filter((d) => d.done).length;
    return {
      key: phase.key,
      title: phase.title,
      steps,
      requiredDone,
      requiredTotal: reqSteps.length,
      complete: requiredDone === reqSteps.length,
    };
  });

  const requiredTotal = phases.reduce((n, p) => n + p.requiredTotal, 0);
  const requiredDone = phases.reduce((n, p) => n + p.requiredDone, 0);

  const warnings: string[] = [];
  const c = input.contract;
  if (c && !c.signedDocumentId && ["accepted", "active", "renewal_in_progress"].includes(c.status)) {
    warnings.push("Agreement not signed. WiFi vouchers stay blocked until a signed copy is attached.");
  }

  return {
    phases,
    contractId: input.contract?.id ?? null,
    nextStep,
    complete: requiredTotal > 0 && requiredDone === requiredTotal,
    requiredDone,
    requiredTotal,
    warnings,
  };
}
