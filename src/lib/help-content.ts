import {
  LayoutDashboard,
  Users,
  GitBranch,
  Activity,
  CheckSquare,
  FileText,
  Receipt,
  ScrollText,
  IndianRupee,
  Calculator,
  DoorOpen,
  CalendarClock,
  FolderOpen,
  Wifi,
  MapPin,
  ClipboardList,
  Server,
  Settings,
  UserPlus,
  Mail,
  CreditCard,
  Rocket,
  TicketCheck,
  LifeBuoy,
  ShoppingCart,
  Briefcase,
  Handshake,
  Wallet,
  type LucideIcon,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Type definitions                                                   */
/* ------------------------------------------------------------------ */

export interface HelpFaqItem {
  question: string;
  answer: string;
}

export interface HelpStep {
  step: number;
  title: string;
  description: string;
}

export interface HelpWorkflow {
  title: string;
  steps: HelpStep[];
}

export interface HelpSection {
  id: string;
  title: string;
  icon: LucideIcon;
  overview: string;
  workflows: HelpWorkflow[];
  tips: string[];
  faqs: HelpFaqItem[];
  roles?: string[] | null; // null = visible to all roles
}

export interface KeyboardShortcut {
  keys: string[];
  description: string;
}

export interface RolePermission {
  feature: string;
  admin: boolean;
  manager: boolean;
  sales_rep: boolean;
  floor_manager: boolean;
}

export interface HelpContentData {
  sections: HelpSection[];
  globalFaqs: HelpFaqItem[];
  keyboardShortcuts: KeyboardShortcut[];
  rolePermissions: RolePermission[];
  supportInfo: {
    email: string;
    phone: string;
  };
}

/* ------------------------------------------------------------------ */
/*  Help content                                                       */
/* ------------------------------------------------------------------ */

export const HELP_CONTENT: HelpContentData = {
  sections: [
    /* ============================================================== */
    /*  1. Getting Started                                             */
    /* ============================================================== */
    {
      id: "getting-started",
      title: "Getting Started",
      icon: Rocket,
      overview:
        "Welcome to The WorkVilla CRM. This application helps you manage leads, bookings, contracts, invoices, and day-to-day operations across all your coworking locations. Use the sidebar on the left to navigate between modules, or press Cmd+K (Ctrl+K on Windows) to quickly jump to any page or search for a lead.",
      workflows: [
        {
          title: "Logging In",
          steps: [
            { step: 1, title: "Open the application", description: "Visit the CRM URL in your browser. You will see the login page." },
            { step: 2, title: "Enter your credentials", description: "Type the email and password provided by your admin." },
            { step: 3, title: "Access the dashboard", description: "After login you land on the Dashboard showing key metrics and recent activities." },
          ],
        },
        {
          title: "Navigating the Application",
          steps: [
            { step: 1, title: "Use the sidebar", description: "The left sidebar organizes modules into collapsible groups: Sales, Finance, Operations, Virtual Offices, Procurement, and Admin. Click a group header to expand or collapse it." },
            { step: 2, title: "Search the sidebar", description: "Type in the search box at the top of the sidebar to instantly filter menu items across all groups. Results show with their section labels." },
            { step: 3, title: "Quick search", description: "Press Cmd+K (or Ctrl+K) to open the command palette. Type a page name or lead name to jump there instantly." },
            { step: 4, title: "Mobile access", description: "On mobile devices, the sidebar slides in from the left. Tap to navigate, and it auto-closes after selection." },
          ],
        },
      ],
      tips: [
        "Bookmark the CRM URL for quick access from your browser.",
        "The sidebar groups auto-expand when you navigate to a page within them — the active item is always visible.",
        "Use the sidebar search box to quickly find any menu item — it searches across all groups.",
        "The command palette (Cmd+K) searches across pages and leads — it is the fastest way to find anything.",
        "If you forget your password, use the 'Forgot Password' link on the login page.",
        "Your role determines which modules and actions are available to you.",
      ],
      faqs: [
        { question: "How do I change my password?", answer: "Go to Settings from the sidebar, then update your password in the Profile section. If you are locked out, use the Forgot Password link on the login page or ask your admin to reset it for you." },
        { question: "Can I access the CRM on my phone?", answer: "Yes. The application is fully responsive. On mobile devices you will see a bottom navigation bar with quick links to Dashboard, Leads, and Tasks. Tap 'More' to access the full sidebar with all modules." },
        { question: "What does the Cmd+K shortcut do?", answer: "It opens the Command Palette — a quick search overlay where you can type to find any page, action, or lead. Use arrow keys to navigate results and Enter to select." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  2. Dashboard                                                   */
    /* ============================================================== */
    {
      id: "dashboard",
      title: "Dashboard",
      icon: LayoutDashboard,
      overview:
        "The Dashboard is your home screen. It shows key performance indicators (KPIs) like total leads, conversion rate, tasks due today, and pending follow-ups. A Follow-ups widget highlights overdue and upcoming follow-up actions so nothing slips through. Recent team activities are shown in a live feed. Use the location filter to focus on a specific coworking center. Admins can configure which widgets are visible for each role, so different team members see the most relevant information.",
      workflows: [
        {
          title: "Reading Your Dashboard",
          steps: [
            { step: 1, title: "Review KPI cards", description: "At the top you will see four metric cards: Total Leads, Conversion Rate, Tasks Due Today, and Pending Follow-ups." },
            { step: 2, title: "Check the Follow-ups widget", description: "The Follow-ups widget lists leads with overdue or upcoming follow-up actions — click any entry to open the lead directly." },
            { step: 3, title: "View recent activities", description: "The Recent Activities feed shows the last team actions (calls, emails, meetings, notes) with who did what and when." },
            { step: 4, title: "Filter by location", description: "Use the location dropdown at the top to filter all dashboard metrics for a specific coworking center." },
          ],
        },
        {
          title: "Configuring Dashboard Widgets per Role (Admin only)",
          steps: [
            { step: 1, title: "Go to Settings → Dashboard Widgets", description: "Navigate to Settings and find the Dashboard Widgets configuration section." },
            { step: 2, title: "Select a role", description: "Choose the role you want to configure (Admin, Manager, Sales Rep, Floor Manager, etc.)." },
            { step: 3, title: "Toggle widgets", description: "Enable or disable individual widgets for the selected role. Changes take effect immediately for all users in that role." },
          ],
        },
      ],
      tips: [
        "Check the dashboard first thing each morning — the Follow-ups widget shows overdue actions that need immediate attention.",
        "A declining conversion rate may indicate leads are stalling — review the Leads list for bottlenecks.",
        "The Follow-ups widget is role-aware: Sales Reps see only their own follow-ups; Managers and Admins see all.",
        "Admins can tailor the dashboard for each role — hide irrelevant widgets to keep the interface clean for each team member.",
      ],
      faqs: [
        { question: "Why are my dashboard numbers different from my colleague's?", answer: "If you are a Sales Rep, you only see leads and tasks assigned to you. Admins and Managers see data for all team members. Filter by location to narrow the view further." },
        { question: "How often does the dashboard refresh?", answer: "The dashboard fetches fresh data each time you visit the page or refresh your browser. There is no auto-refresh interval." },
        { question: "What does the Follow-ups widget show?", answer: "It lists leads whose scheduled follow-up date has passed (overdue) or is coming up soon, sorted by urgency. Click any row to open the lead and take action." },
        { question: "I can't see a widget my colleague can see. Why?", answer: "Admins can configure which widgets are visible per role. If a widget is missing, ask your admin to enable it for your role in Settings → Dashboard Widgets." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  3. Leads                                                       */
    /* ============================================================== */
    {
      id: "leads",
      title: "Leads",
      icon: Users,
      overview:
        "Leads represent potential customers interested in your coworking spaces. Each lead tracks contact details, company information, workspace requirements, and their journey from initial inquiry to becoming a member. You can create, edit, rate, and move leads through statuses as they progress. Email and mobile number are mandatory fields for every lead. The leads list is sorted by follow-up urgency — overdue follow-ups appear first so the most time-sensitive actions are always at the top.",
      workflows: [
        {
          title: "Creating a New Lead",
          steps: [
            { step: 1, title: "Click 'New Lead'", description: "Go to the Leads page and click the 'New Lead' button in the top right corner." },
            { step: 2, title: "Fill in contact details", description: "Enter the lead's first name, last name, email, and mobile number (both are mandatory). Add company name and any other details." },
            { step: 3, title: "Set workspace requirements", description: "Select the workspace type (dedicated desk, private office, etc.), preferred location, and number of seats needed." },
            { step: 4, title: "Choose source and status", description: "Select how the lead found you (website, referral, cold outreach, etc.) and set the initial status (usually 'New')." },
            { step: 5, title: "Save", description: "Click Save to create the lead. You will be redirected to the lead detail page." },
          ],
        },
        {
          title: "Progressing a Lead Through Stages",
          steps: [
            { step: 1, title: "Open the lead", description: "Click on a lead from the list to open their detail page." },
            { step: 2, title: "Update the status", description: "Use the status dropdown to move the lead to the next stage: New → Qualified → Proposal Sent → Negotiation → Won or Lost." },
            { step: 3, title: "Log activities", description: "Record calls, meetings, emails, and notes in the Activities tab to keep a full history of interactions." },
            { step: 4, title: "Create a proposal", description: "When the lead is qualified, create a proposal from their detail page and email it to them." },
          ],
        },
      ],
      tips: [
        "Email and mobile are mandatory — you cannot save a lead without both fields filled in.",
        "The leads list is automatically sorted by follow-up urgency: overdue follow-ups appear first, then upcoming ones, then the rest.",
        "Use the star rating (1-5) to quickly prioritize high-value leads.",
        "Filter the leads list by status, source, or location to find exactly what you need.",
        "Each lead detail page shows related proposals, contracts, activities, and tasks in separate tabs.",
        "Sales Reps only see their own leads. Managers and Admins see all leads.",
      ],
      faqs: [
        { question: "What do the lead statuses mean?", answer: "New: Just entered the system. Qualified: Confirmed as a real opportunity. Proposal Sent: A proposal has been emailed. Negotiation: Active discussions on terms. Won: Converted to a customer. Lost: Did not convert." },
        { question: "Can I assign a lead to another team member?", answer: "Yes. Open the lead's edit page and change the 'Assigned To' field to another team member. They will then see the lead in their own leads list." },
        { question: "How do I find a specific lead?", answer: "Use the search bar at the top of the leads list to search by name, email, or company. You can also use Cmd+K to search globally." },
        { question: "Why is the leads list sorted in a specific order?", answer: "The list sorts by follow-up urgency: leads with overdue follow-up dates appear first, followed by those with upcoming follow-ups. This ensures the most time-sensitive actions are always visible at the top." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  4. Pipeline                                                    */
    /* ============================================================== */
    {
      id: "pipeline",
      title: "Pipeline",
      icon: GitBranch,
      overview:
        "The Pipeline view shows all your leads in a visual Kanban board, organized by status. Each column represents a stage (New, Qualified, Proposal Sent, etc.). You can drag and drop leads between columns to update their status instantly.",
      workflows: [
        {
          title: "Managing Leads via Pipeline",
          steps: [
            { step: 1, title: "View the board", description: "Navigate to Pipeline from the sidebar. You will see columns for each lead status." },
            { step: 2, title: "Drag and drop", description: "Click and hold a lead card, then drag it to a different column to change its status." },
            { step: 3, title: "Click for details", description: "Click on any lead card to open the full lead detail page." },
          ],
        },
      ],
      tips: [
        "The Pipeline view is ideal for daily stand-ups and sales meetings — it gives a visual overview of your funnel.",
        "Each card shows the lead's name, company, and value to help prioritize at a glance.",
        "Drag-and-drop automatically updates the lead status in the database.",
      ],
      faqs: [
        { question: "Can I filter the pipeline by location?", answer: "Yes. Use the location filter at the top to show leads for a specific coworking center only." },
        { question: "Is the Pipeline the same data as the Leads list?", answer: "Yes, it shows the same leads but in a visual Kanban layout instead of a table. Changes made in either view are reflected in both." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  5. Activities                                                  */
    /* ============================================================== */
    {
      id: "activities",
      title: "Activities",
      icon: Activity,
      overview:
        "Activities are a chronological log of all team interactions with leads. Every call, meeting, email, tour, or note is recorded here. This module gives you a complete audit trail of communications and helps ensure no follow-up is missed.",
      workflows: [
        {
          title: "Logging an Activity",
          steps: [
            { step: 1, title: "Open a lead", description: "Navigate to the lead's detail page and go to the Activities tab." },
            { step: 2, title: "Click 'Add Activity'", description: "Click the Add Activity button to open the activity form." },
            { step: 3, title: "Select activity type", description: "Choose from: Call, Meeting, Note, Email, or Tour." },
            { step: 4, title: "Fill in details", description: "Add a subject, description, duration (for calls), or meeting location. Set the date and time." },
            { step: 5, title: "Save", description: "Click Save. The activity will appear in the chronological timeline." },
          ],
        },
      ],
      tips: [
        "Always log activities immediately after a call or meeting while details are fresh.",
        "Use the Activities page (sidebar) to see all team activities across all leads in one place.",
        "Filter by activity type to review only calls, only meetings, etc.",
        "Email sends from the CRM are automatically logged as activities.",
      ],
      faqs: [
        { question: "Are emails automatically logged?", answer: "Yes. When you send a proposal, invoice, contract, or booking confirmation from the CRM, it is automatically logged as an email activity on the lead's timeline." },
        { question: "Can I edit or delete an activity?", answer: "Activities are meant to be an immutable audit trail. Once created, they cannot be edited or deleted. If you made an error, add a new 'Note' activity with the correction." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  6. Tasks                                                       */
    /* ============================================================== */
    {
      id: "tasks",
      title: "Tasks",
      icon: CheckSquare,
      overview:
        "Tasks help you track to-dos and follow-ups. Each task has a title, description, priority (low/medium/high), due date, and can be assigned to a team member and linked to a lead. Tasks flow through three stages: To Do → In Progress → Done.",
      workflows: [
        {
          title: "Creating and Managing Tasks",
          steps: [
            { step: 1, title: "Click 'New Task'", description: "Go to the Tasks page and click 'New Task'." },
            { step: 2, title: "Fill in details", description: "Enter a title, description, set priority, due date, assign to a team member, and optionally link to a lead." },
            { step: 3, title: "Track progress", description: "Click the colored status dots on each task to quickly cycle through: To Do → In Progress → Done." },
          ],
        },
      ],
      tips: [
        "Tasks due today appear on the Dashboard KPI card. Check them each morning.",
        "Click the status dot to quickly toggle a task's status without opening it.",
        "High-priority tasks are highlighted to draw attention.",
        "Filter by status (To Do, In Progress, Done) and priority to focus on what matters.",
      ],
      faqs: [
        { question: "Can I assign a task to someone else?", answer: "Yes. When creating or editing a task, use the 'Assign To' dropdown to select any team member." },
        { question: "What happens to overdue tasks?", answer: "Overdue tasks remain in their current status but are flagged visually with a red indicator. They also show up in the Dashboard's 'Tasks Due Today' count." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  7. Proposals                                                   */
    /* ============================================================== */
    {
      id: "proposals",
      title: "Proposals",
      icon: FileText,
      overview:
        "Proposals are formal workspace offers sent to qualified leads. Each proposal is auto-numbered (PROP-XXXX), contains pricing details and workspace specifications, and can be emailed directly to the lead as a PDF attachment from the CRM. When a proposal is rejected, a rejection reason must be recorded. KYC documents can be attached directly to a proposal.",
      workflows: [
        {
          title: "Creating and Sending a Proposal",
          steps: [
            { step: 1, title: "Navigate to the lead", description: "Open the lead's detail page for whom you want to create a proposal." },
            { step: 2, title: "Click 'Create Proposal'", description: "In the Proposals tab, click 'Create Proposal'. The lead details will be pre-filled." },
            { step: 3, title: "Configure the proposal", description: "Add a title, set the workspace type, pricing, duration, and any special terms." },
            { step: 4, title: "Save as draft", description: "Save the proposal. It starts in 'Draft' status." },
            { step: 5, title: "Email to the client", description: "Open the proposal and click 'Email'. Add recipient(s) and send. The proposal PDF is attached automatically." },
          ],
        },
        {
          title: "Rejecting a Proposal",
          steps: [
            { step: 1, title: "Open the proposal", description: "Navigate to the proposal you need to mark as rejected." },
            { step: 2, title: "Click 'Reject'", description: "Select the Reject action. A dialog will prompt you for a rejection reason." },
            { step: 3, title: "Enter the reason", description: "Type the reason the client declined (e.g., price too high, chose competitor, requirement changed). This is required." },
            { step: 4, title: "Confirm", description: "Save. The proposal moves to 'Rejected' status and the reason is stored for future reference." },
          ],
        },
        {
          title: "Attaching KYC Documents to a Proposal",
          steps: [
            { step: 1, title: "Open the proposal", description: "Navigate to the relevant proposal." },
            { step: 2, title: "Go to the Documents section", description: "Scroll to or select the Documents/KYC section within the proposal." },
            { step: 3, title: "Upload files", description: "Upload ID proof, address proof, or other KYC documents. PDF and image formats are supported." },
          ],
        },
      ],
      tips: [
        "You can add multiple email recipients when sending — add the lead's email plus any additional contacts.",
        "After sending, the proposal status changes to 'Sent' and the lead status updates to 'Proposal Sent'.",
        "Review the PDF preview before sending to ensure formatting is correct.",
        "Proposal PDFs include a UPI QR code from the payment module, making it easy for clients to pay directly by scanning.",
        "Always log a rejection reason — this data helps identify why deals are lost and improve future pitches.",
        "Proposals that receive no response can be manually set to 'Expired'.",
      ],
      faqs: [
        { question: "Can I edit a proposal after sending it?", answer: "Yes, you can edit the proposal content. However, the previously sent PDF will not update in the recipient's inbox. You would need to re-send the updated version." },
        { question: "What email address are proposals sent from?", answer: "All emails are sent from contact@theworkvilla.com via Google Workspace. Recipients can reply directly to this address." },
        { question: "Can I send a proposal to multiple people?", answer: "Yes. In the email dialog, type each additional email address and press Enter to add them. All recipients will receive the same email with the proposal PDF attached." },
        { question: "Is a rejection reason mandatory?", answer: "Yes. When rejecting a proposal, you must enter a reason. This ensures there is always an explanation on record for why an opportunity was lost." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  8. Invoices                                                    */
    /* ============================================================== */
    {
      id: "invoices",
      title: "Invoices",
      icon: Receipt,
      overview:
        "The Invoices module lets you generate proforma invoices for your clients. Each invoice is auto-numbered, linked to a lead, and can be emailed as a PDF. Track invoice status from Draft through to Paid or Overdue.",
      workflows: [
        {
          title: "Creating and Sending an Invoice",
          steps: [
            { step: 1, title: "Go to Invoices", description: "Navigate to the Invoices page from the sidebar." },
            { step: 2, title: "Click 'New Invoice'", description: "Click the create button to start a new proforma invoice." },
            { step: 3, title: "Fill in details", description: "Select the lead, add line items with descriptions and amounts, and set the due date." },
            { step: 4, title: "Save and send", description: "Save the invoice, then click 'Email' to send the PDF to the client." },
          ],
        },
      ],
      tips: [
        "Overdue invoices are highlighted in red so they stand out in the list.",
        "Use the status filter to quickly find all unpaid or overdue invoices.",
        "The invoice PDF includes your company bank details for payment.",
      ],
      faqs: [
        { question: "What is the difference between an Invoice and a GST Invoice?", answer: "The Invoices module creates proforma invoices for quoting. GST Invoices in the Accounting module are official tax invoices used for compliance and filing." },
        { question: "Can I mark an invoice as paid?", answer: "Yes. Open the invoice and change its status to 'Paid' when payment is confirmed." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  9. Contracts                                                   */
    /* ============================================================== */
    {
      id: "contracts",
      title: "Contracts",
      icon: ScrollText,
      overview:
        "Contracts (Membership Agreements) formalize the relationship between The WorkVilla and a client. Each contract specifies workspace details, monthly fees, tenure, billing cycle, and key dates. Contracts are linked to leads and track associated payments.",
      workflows: [
        {
          title: "Creating a Membership Agreement",
          steps: [
            { step: 1, title: "Go to Contracts", description: "Navigate to the Contracts page and click 'New Contract'." },
            { step: 2, title: "Link to a lead", description: "Select the lead this contract is for. Their details will be pre-filled." },
            { step: 3, title: "Set terms", description: "Configure the title, start date, tenure (months), billing cycle (monthly/quarterly/annual), and total monthly fee." },
            { step: 4, title: "Save as draft", description: "Save the contract. It starts in 'Draft' status." },
            { step: 5, title: "Email for signing", description: "Click 'Email' to send the contract PDF to the client for review and signing." },
            { step: 6, title: "Activate", description: "Once signed, update the status to 'Active'. This is now a live membership." },
          ],
        },
      ],
      tips: [
        "The contract email includes bank details so the client knows where to make payments.",
        "Use 'Send to Client' to automatically email the signed agreement PDF directly to the client — no need to export and attach manually.",
        "Use the search and date filters to find contracts by number, lead name, or date range.",
        "Active contracts appear in the Accounting module for monthly billing.",
      ],
      faqs: [
        { question: "What happens when a contract ends?", answer: "When a contract reaches its end date, you can update the status to 'Completed' or create a new contract for renewal." },
        { question: "Can I cancel an active contract?", answer: "Yes. Change the contract status to 'Cancelled'. Note that this does not automatically handle any outstanding payments." },
        { question: "How do I send the signed agreement to the client?", answer: "Use the 'Send to Client' action on the contract. The system will automatically generate the agreement PDF and email it directly to the client's registered email address." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  10. Billing                                                    */
    /* ============================================================== */
    {
      id: "billing",
      title: "Billing",
      icon: IndianRupee,
      overview:
        "The Billing module handles ad-hoc usage charges and periodic billing statements. Add extra charges to contracts (meeting room usage, printing, etc.) and generate billing statements that summarize all charges for a period.",
      workflows: [
        {
          title: "Adding a Usage Charge",
          steps: [
            { step: 1, title: "Go to Billing", description: "Navigate to Billing from the sidebar." },
            { step: 2, title: "Open Usage Charges tab", description: "Select the 'Usage Charges' tab." },
            { step: 3, title: "Click 'Add Charge'", description: "Click the button to add a new charge." },
            { step: 4, title: "Fill in details", description: "Select the contract, enter a description, quantity, and unit price. Set the charge date." },
            { step: 5, title: "Save", description: "Save the charge. It starts as 'Pending' and can later be billed or waived." },
          ],
        },
        {
          title: "Generating a Billing Statement",
          steps: [
            { step: 1, title: "Open Billing Statements tab", description: "Switch to the 'Billing Statements' tab." },
            { step: 2, title: "Create new statement", description: "Click 'New Statement'. Select the contract and period dates." },
            { step: 3, title: "Review amounts", description: "The statement will show fixed (contract) and variable (usage charges) amounts." },
            { step: 4, title: "Finalize", description: "Click 'Finalize' to lock the statement. It can then be exported." },
          ],
        },
      ],
      tips: [
        "Usage charges in 'Pending' status can be edited. Once billed, they are locked.",
        "Billing statements can be filtered by contract and date range.",
        "Use the 'Waive' action to write off a charge without billing it.",
      ],
      faqs: [
        { question: "What is the difference between Billing and Accounting?", answer: "Billing handles individual charges and statements per contract. Accounting provides a monthly overview across all contracts, walk-in collections, cash handovers, and GST invoices." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  11. Accounting                                                 */
    /* ============================================================== */
    {
      id: "accounting",
      title: "Accounting",
      icon: Calculator,
      overview:
        "The Accounting module provides a monthly financial overview. Select a month and see all contract revenue, walk-in collections, cash handovers, GST invoices, and petty cash in one place. An 'Action Required' banner at the top aggregates all pending items across tabs — outstanding payments, cash handovers, GST invoices to send, petty cash to issue, and expenses to approve — so nothing is missed. Periods can be locked after reconciliation to prevent further changes.",
      workflows: [
        {
          title: "Reviewing a Monthly Period",
          steps: [
            { step: 1, title: "Select the month", description: "Use the month picker at the top to select the year and month you want to review." },
            { step: 2, title: "Review Contracts tab", description: "See all contract-based revenue, facility usage charges, and payment status for the month." },
            { step: 3, title: "Check Walk-in Collections", description: "Switch to the Walk-in tab to see one-time payments from walk-in customers." },
            { step: 4, title: "Review Cash Handovers", description: "Check the Cash Handovers tab for pending and completed cash transfers." },
            { step: 5, title: "Manage GST Invoices", description: "The GST Invoices tab shows all tax invoices for the period with their filing status." },
            { step: 6, title: "Lock the period", description: "Once reconciliation is complete, lock the period to prevent changes. Only Admins and Managers can lock periods." },
          ],
        },
      ],
      tips: [
        "The 'Action Required' banner shows a count of all pending items and is collapsible. Click any item to jump to the relevant tab.",
        "Action items include: outstanding payments, pending cash handovers, GST invoices to send, petty cash to issue, and expenses awaiting admin approval.",
        "Summary cards at the top show totals: Billable, Collected, Outstanding, Cash Pending, and Cash Handed Over.",
        "The aging analysis shows current vs 30/60/90-day overdue amounts.",
        "Locked periods display a status bar showing who locked them and when.",
        "GST invoices can be uploaded as PDFs and emailed to clients directly.",
        "The Petty Cash tab shows all books, approvals, and fund request management within the Accounting page.",
      ],
      faqs: [
        { question: "Can I unlock a locked period?", answer: "Yes. An Admin or Manager can unlock a period to make corrections, then lock it again." },
        { question: "What does the 'Carried Forward' amount mean?", answer: "It represents outstanding balances from previous periods that are still unpaid." },
        { question: "What is the Action Required banner?", answer: "An orange banner at the top of the Accounting page that aggregates all pending items: outstanding contract payments, pending cash handovers, GST invoices to send, petty cash funds to issue, and expenses awaiting admin approval. Click any item to jump to the relevant tab. The banner is collapsible and hides when there are no action items." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  12. Spaces                                                     */
    /* ============================================================== */
    {
      id: "spaces",
      title: "Spaces",
      icon: DoorOpen,
      overview:
        "Spaces are the bookable rooms and desks in your coworking centers. Each space has a name, capacity, hourly rate, associated facilities (whiteboard, projector, WiFi, etc.), and belongs to a specific location. Spaces can be set as active or inactive.",
      workflows: [
        {
          title: "Managing Spaces",
          steps: [
            { step: 1, title: "Go to Spaces", description: "Navigate to Spaces from the sidebar." },
            { step: 2, title: "Add a new space", description: "Click 'Add Space' and fill in the name, location, capacity, hourly rate, and select available facilities." },
            { step: 3, title: "Edit or deactivate", description: "Click the edit button on any space to update details or toggle active/inactive status." },
          ],
        },
      ],
      tips: [
        "Inactive spaces will not appear in the booking form, preventing new bookings.",
        "Use the location and status filters to quickly find spaces.",
        "The capacity field helps validate bookings — ensure it matches the actual room capacity.",
      ],
      faqs: [
        { question: "Can I delete a space?", answer: "Spaces with existing bookings cannot be deleted. Instead, set the space to 'Inactive' to prevent new bookings while preserving historical data." },
        { question: "What are facilities?", answer: "Facilities are amenities available in a space, such as whiteboard, projector, TV screen, WiFi, etc. They are displayed on booking confirmations." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  13. Bookings                                                   */
    /* ============================================================== */
    {
      id: "bookings",
      title: "Bookings",
      icon: CalendarClock,
      overview:
        "Bookings manage conference room and desk reservations. You can create bookings for contract members, walk-in guests, or customers using prepaid packages (Booking Slots credits). The module supports recurring bookings, check-in/check-out workflows, payment collection via Razorpay, feedback collection, and post-visit analytics. View bookings in a list, calendar, or analytics dashboard.",
      workflows: [
        {
          title: "Creating a New Booking",
          steps: [
            { step: 1, title: "Click 'New Booking'", description: "Go to Bookings and click 'New Booking'." },
            { step: 2, title: "Select customer type", description: "Choose 'Member' (for contract holders), 'Walk-in' (for one-time guests), or select a prepaid package holder to deduct a Booking Slot credit." },
            { step: 3, title: "Fill in details", description: "Select the space, date, start time, end time, and enter guest information (name, phone, email)." },
            { step: 4, title: "Set payment", description: "The amount is calculated based on duration and hourly rate. Choose the payment method, or for prepaid customers, confirm the credit deduction." },
            { step: 5, title: "Confirm", description: "Save the booking. A confirmation email is sent automatically." },
          ],
        },
        {
          title: "Creating a Recurring Booking",
          steps: [
            { step: 1, title: "Start a new booking", description: "Click 'New Booking' and fill in all the standard details." },
            { step: 2, title: "Enable recurrence", description: "Toggle the 'Recurring' option. Choose the frequency (daily, weekly, monthly) and end date or number of occurrences." },
            { step: 3, title: "Review instances", description: "The system previews all generated booking dates. Adjust if needed." },
            { step: 4, title: "Confirm", description: "Save to create all recurring instances at once. Each can be managed individually thereafter." },
          ],
        },
        {
          title: "Check-in and Check-out Workflow",
          steps: [
            { step: 1, title: "Find the booking", description: "In the bookings list, find the confirmed booking (Today — Upcoming section)." },
            { step: 2, title: "Check in", description: "Click the check-in button when the guest arrives. The booking status changes to 'Checked In'." },
            { step: 3, title: "Collect payment", description: "For walk-in guests, collect payment using the Razorpay payment link or record manual payment." },
            { step: 4, title: "Check out", description: "When the guest leaves, click 'Check Out'. The booking moves to 'Checked Out'." },
            { step: 5, title: "Request feedback", description: "After check-out, you can send a feedback link to the guest via email." },
          ],
        },
        {
          title: "Rebooking a Previous Booking",
          steps: [
            { step: 1, title: "Find the past booking", description: "Open the completed booking you want to repeat." },
            { step: 2, title: "Click 'Book Again'", description: "From the actions menu, click 'Book Again'. A new booking form opens pre-filled with the same details." },
            { step: 3, title: "Adjust dates", description: "Change the date and time as needed, then save." },
          ],
        },
      ],
      tips: [
        "Use the Calendar view to see room availability at a glance for the week or month.",
        "The Analytics tab shows room utilization rates, revenue reports, and customer segments.",
        "Walk-in bookings with pending payment show a 'Collect Payment' button with Razorpay integration.",
        "After payment is collected via Razorpay, the booking automatically shows a green 'Payment Collected' banner.",
        "Use the search bar to find bookings by guest phone number, name, or booking number.",
        "Recurring bookings are ideal for members with regular weekly or monthly room reservations.",
        "When a prepaid package holder books, one Booking Slot credit is deducted from their package balance automatically.",
        "If a customer has outstanding unpaid charges, an amber warning banner appears on the booking form showing the total due and up to 5 individual charges — consider collecting during the transaction.",
      ],
      faqs: [
        { question: "What is the difference between Member and Walk-in bookings?", answer: "Member bookings are for existing contract holders — their details are pre-filled and billing may go through the contract. Walk-in bookings are for one-time guests who pay at the time of booking." },
        { question: "How does Razorpay payment collection work?", answer: "For walk-in bookings with pending payment, click 'Collect Payment' to generate a Razorpay payment link. You can send this link to the guest or process the payment on-site. Once paid, the status updates automatically." },
        { question: "How do prepaid Booking Slots work?", answer: "If a customer has a prepaid package with Booking Slots credits, you can select their package when creating a booking. One slot is deducted from their balance. The remaining balance is shown on the package detail page." },
        { question: "Can I cancel a recurring booking series?", answer: "Individual instances can be cancelled one at a time. There is no bulk-cancel for a full recurring series — cancel each occurrence as needed." },
        { question: "Can I cancel a booking?", answer: "Yes. Open the booking and click 'Cancel'. Cancelled bookings are preserved in history but marked as cancelled." },
        { question: "How does the feedback system work?", answer: "After a guest checks out, you can send them a feedback link via email. The guest rates their experience on a public page (no login required). Feedback scores appear in the booking details and analytics." },
        { question: "What is the outstanding charges warning on the booking form?", answer: "When creating a booking for a customer with unpaid usage charges, an amber warning banner displays the total outstanding amount and lists up to 5 individual charges. This is informational — you can proceed with the booking and collect outstanding amounts separately or at the same time." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  14. Documents                                                  */
    /* ============================================================== */
    {
      id: "documents",
      title: "Documents",
      icon: FolderOpen,
      overview:
        "The Documents module is a centralized file repository. Upload contracts, proposals, invoices, images, and any other files. Documents are stored securely and can be downloaded at any time.",
      workflows: [
        {
          title: "Uploading a Document",
          steps: [
            { step: 1, title: "Go to Documents", description: "Navigate to Documents from the sidebar." },
            { step: 2, title: "Upload", description: "Click the upload area or drag and drop a file. Supported formats include PDF, images, and common document types." },
            { step: 3, title: "Add metadata", description: "Enter a title and select the category (general, contracts, proposals, invoices, etc.)." },
            { step: 4, title: "Save", description: "The file is uploaded and appears in the document list." },
          ],
        },
      ],
      tips: [
        "Use categories to organize documents and make them easier to find.",
        "File sizes and types are shown in the list for quick reference.",
        "Click the download button to get a copy of any document.",
      ],
      faqs: [
        { question: "Is there a file size limit?", answer: "Files up to 50 MB can be uploaded. For larger files, consider compressing them first." },
        { question: "Who can see uploaded documents?", answer: "All authenticated team members can view and download documents. There is no per-document access control." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  15. Vouchers                                                   */
    /* ============================================================== */
    {
      id: "vouchers",
      title: "Vouchers",
      icon: Wifi,
      overview:
        "Vouchers are WiFi access codes that can be issued to leads, customers, or walk-in visitors. Available validity periods include 3 Hours, 1 Day, 7 Days, 30 Days, 60 Days, 90 Days, 180 Days, and 365 Days. The Inventory view shows stock levels grouped by validity period. New voucher codes are uploaded in bulk via PDF. Each voucher has a lifecycle: Available → Issued → Used/Expired/Revoked. Per-seat voucher issuance requires OTP authorization from the manager to control usage.",
      workflows: [
        {
          title: "Managing Voucher Inventory",
          steps: [
            { step: 1, title: "Check stock", description: "Go to Vouchers and view the Inventory tab. Cards show available stock grouped by validity period (3 Hours, 1 Day, 7 Days, 30 Days, 60 Days, 90 Days, 180 Days, 365 Days)." },
            { step: 2, title: "Upload new vouchers", description: "Click 'Upload' to import new voucher codes from a PDF file. Set the validity period and location." },
            { step: 3, title: "Issue vouchers", description: "From a lead or contract, issue a voucher to the customer. The voucher status changes to 'Issued'." },
            { step: 4, title: "Track usage", description: "Use the All Vouchers tab to see all voucher codes, their status, and issue dates." },
          ],
        },
        {
          title: "Issuing a Per-Seat Voucher (OTP Authorization)",
          steps: [
            { step: 1, title: "Select the voucher type", description: "When issuing a per-seat voucher, the system triggers an OTP authorization flow." },
            { step: 2, title: "Manager receives OTP", description: "An OTP is sent to the manager's registered phone number." },
            { step: 3, title: "Enter OTP", description: "The manager enters the OTP in the CRM to authorize the issuance. This prevents unauthorized voucher handouts." },
            { step: 4, title: "Voucher issued", description: "Once the OTP is verified, the voucher is issued and marked in the system." },
          ],
        },
      ],
      tips: [
        "Low stock is highlighted with visual warnings on the inventory cards.",
        "The 3-hour voucher type is ideal for day-use visitors who need short-term WiFi access.",
        "Search by voucher code in the All Vouchers tab to quickly check a specific code's status.",
        "Expired vouchers are automatically marked but can be revoked manually if needed.",
        "The OTP authorization for per-seat vouchers ensures accountability and prevents misuse.",
      ],
      faqs: [
        { question: "What voucher validity periods are available?", answer: "Eight types: 3 Hours (short-term visitors), 1 Day, 7 Days, 30 Days, 60 Days, 90 Days, 180 Days, and 365 Days. Each type has its own inventory pool." },
        { question: "Why is an OTP required for per-seat vouchers?", answer: "Per-seat vouchers are higher-value passes. The OTP authorization step ensures a manager approves each issuance, maintaining accountability and preventing unauthorized use." },
        { question: "How do I revoke an issued voucher?", answer: "Find the voucher in the All Vouchers list and change its status to 'Revoked'. This prevents the code from being used." },
        { question: "Can vouchers be emailed to customers?", answer: "Yes. Vouchers associated with contracts can be emailed to the client directly from the contract detail page." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  16. Locations                                                  */
    /* ============================================================== */
    {
      id: "locations",
      title: "Locations",
      icon: MapPin,
      overview:
        "Locations represent your coworking centers. Each location has a name, code, city, and address. Location data is used across the CRM to filter leads, bookings, spaces, and financial data by center.",
      workflows: [
        {
          title: "Managing Locations",
          steps: [
            { step: 1, title: "Go to Locations", description: "Navigate to Locations from the sidebar (Admin/Manager only)." },
            { step: 2, title: "Add a location", description: "Click 'Add Location' and enter the name, code, city, and full address." },
            { step: 3, title: "Edit or deactivate", description: "Click Edit on any location to update details or toggle active/inactive." },
          ],
        },
      ],
      tips: [
        "Location codes (e.g., 'TWV-CHN') are used in document numbering and internal references.",
        "Deactivating a location hides it from dropdown filters but preserves historical data.",
      ],
      faqs: [
        { question: "What happens if I deactivate a location?", answer: "Existing bookings, contracts, and leads linked to that location remain intact. The location simply stops appearing in dropdown menus for new entries." },
      ],
      roles: ["admin", "manager"],
    },

    /* ============================================================== */
    /*  17. Team                                                       */
    /* ============================================================== */
    {
      id: "team",
      title: "Team Management",
      icon: UserPlus,
      overview:
        "The Team module lets you manage CRM users. Admins can create new users, assign roles, change passwords, and suspend or activate accounts. Each user has a role that determines their access level.",
      workflows: [
        {
          title: "Adding a New Team Member",
          steps: [
            { step: 1, title: "Go to Team", description: "Navigate to Team from the sidebar." },
            { step: 2, title: "Click 'Add User'", description: "Click the Add User button (Admin only)." },
            { step: 3, title: "Fill in details", description: "Enter full name, email, phone number, password, and select a role." },
            { step: 4, title: "Save", description: "The new user can now log in with the provided credentials." },
          ],
        },
      ],
      tips: [
        "Suspended users cannot log in but their data (leads, activities) is preserved.",
        "Only Admins can change user roles and reset passwords.",
        "See the Role Permissions section below for a complete breakdown of what each role can access.",
      ],
      faqs: [
        { question: "What are the available roles?", answer: "Admin: Full access including user management and deletion. Manager: Full data access across all leads and records. Sales Rep: Only sees own leads and assigned tasks. Floor Manager: Focus on space and booking operations." },
        { question: "Can I delete a user?", answer: "Users cannot be deleted to preserve data integrity. Instead, suspend the user to revoke their access." },
      ],
      roles: ["admin", "manager", "sales_rep"],
    },

    /* ============================================================== */
    /*  18. Settings                                                   */
    /* ============================================================== */
    {
      id: "settings",
      title: "Settings",
      icon: Settings,
      overview:
        "Settings lets you manage your profile and configure payment gateway credentials. Update your name and phone number in the Profile tab. Admins can configure Razorpay API keys in the Payment Gateway tab.",
      workflows: [
        {
          title: "Updating Your Profile",
          steps: [
            { step: 1, title: "Go to Settings", description: "Navigate to Settings from the sidebar." },
            { step: 2, title: "Edit your details", description: "Update your full name and phone number. Email and role are read-only." },
            { step: 3, title: "Save", description: "Click Save to update your profile." },
          ],
        },
      ],
      tips: [
        "Your profile name appears in email sign-offs when you send documents from the CRM.",
        "The Payment Gateway tab is only visible to Admins.",
      ],
      faqs: [
        { question: "Can I change my email address?", answer: "No. Email addresses are tied to your login credentials and cannot be changed from Settings. Contact your admin if you need to update your email." },
      ],
      roles: ["admin"],
    },

    /* ============================================================== */
    /*  19. Audit Logs                                                 */
    /* ============================================================== */
    {
      id: "audit-logs",
      title: "Audit Logs",
      icon: ClipboardList,
      overview:
        "Audit Logs provide a comprehensive trail of all changes made in the CRM. Every create, update, delete, and login action is recorded with who did it, when, and what changed. This is essential for compliance and troubleshooting.",
      workflows: [
        {
          title: "Reviewing Audit Logs",
          steps: [
            { step: 1, title: "Go to Audit Logs", description: "Navigate to Audit Logs from the sidebar (Admin/Manager only)." },
            { step: 2, title: "Browse entries", description: "Logs show the timestamp, user, action type, entity type, and detailed changes." },
            { step: 3, title: "Filter", description: "Use the entity type and action filters to narrow down the log entries." },
            { step: 4, title: "View changes", description: "Click on any log entry to see the exact fields that changed, with old and new values side by side." },
          ],
        },
      ],
      tips: [
        "Use audit logs to investigate who changed a lead status, contract amount, or any other field.",
        "Filter by 'login' action to review user login history.",
        "Logs are paginated at 30 entries per page. Use the navigation to browse older entries.",
      ],
      faqs: [
        { question: "Can audit logs be deleted?", answer: "No. Audit logs are immutable and cannot be edited or deleted by anyone, including admins. This ensures a reliable change history." },
      ],
      roles: ["admin", "manager"],
    },

    /* ============================================================== */
    /*  20. Infrastructure                                             */
    /* ============================================================== */
    {
      id: "infrastructure",
      title: "Infrastructure",
      icon: Server,
      overview:
        "The Infrastructure page provides real-time monitoring of the systems powering the CRM. It shows database usage, hosting metrics, email sending quotas, live Vercel deployment usage, an email sent counter, and a breakdown of database table sizes. Use this to ensure the system is healthy and within resource limits.",
      workflows: [
        {
          title: "Monitoring System Health",
          steps: [
            { step: 1, title: "Go to Infrastructure", description: "Navigate to Infrastructure from the sidebar (Admin only)." },
            { step: 2, title: "Review metrics", description: "Check Supabase (database), Vercel (hosting), and Email Service panels for usage levels. The Vercel panel shows live bandwidth and function invocation counts." },
            { step: 3, title: "Check the email counter", description: "The email sent counter shows how many emails have been dispatched from the CRM, helping you track send volume against your provider quota." },
            { step: 4, title: "Check alerts", description: "Amber (60%+) and red (80%+) indicators flag high resource usage." },
            { step: 5, title: "Refresh data", description: "Click Refresh to fetch the latest metrics. Data is cached for 24 hours." },
          ],
        },
      ],
      tips: [
        "Monitor the database row count to track growth over time.",
        "The live Vercel usage panel shows real-time bandwidth and function execution against your plan limits.",
        "The email sent counter gives a quick snapshot of send volume — useful for spotting unexpected spikes.",
        "Email quotas reset daily and monthly. If sending fails, check if the quota is exhausted.",
        "Use the external dashboard links to access Supabase, Vercel, or Email provider consoles directly.",
      ],
      faqs: [
        { question: "What do the color indicators mean?", answer: "Green: Usage is normal (under 60%). Amber: Usage is elevated (60-80%). Red: Usage is high (over 80%) — consider upgrading or optimizing." },
        { question: "What does the email sent counter show?", answer: "It shows the total number of emails sent from the CRM (proposals, contracts, invoices, etc.) allowing you to monitor send volume and check if you are approaching provider limits." },
      ],
      roles: ["admin"],
    },

    /* ============================================================== */
    /*  21. Email System                                               */
    /* ============================================================== */
    {
      id: "email-system",
      title: "Email & SMS System",
      icon: Mail,
      overview:
        "The CRM sends emails via Google Workspace SMTP using the contact@theworkvilla.com address. Emails are sent for proposals, contracts, invoices, booking confirmations, payment reminders, feedback requests, and vouchers. All sent emails are logged as activities on the lead's timeline. In addition, the CRM sends DLT-compliant transactional SMS messages via MSG91 for key customer touchpoints, using pre-approved templates registered with India's telecom regulatory framework.",
      workflows: [
        {
          title: "Sending an Email from the CRM",
          steps: [
            { step: 1, title: "Open the document", description: "Navigate to the proposal, contract, invoice, or booking you want to email." },
            { step: 2, title: "Click 'Email'", description: "Click the Email button. A dialog opens with the lead's email pre-filled." },
            { step: 3, title: "Add recipients", description: "The lead's email is the default recipient. Type additional email addresses and press Enter to add more." },
            { step: 4, title: "Send", description: "Click Send. The PDF is generated and sent as an attachment. The email activity is logged automatically." },
          ],
        },
      ],
      tips: [
        "All emails include a 'Reply-To' header pointing to contact@theworkvilla.com so recipients can reply directly.",
        "The sender's name (your profile name) appears in the email sign-off.",
        "Multiple recipients are supported — simply add more email addresses in the dialog.",
        "Check the Activities tab on the lead's page to confirm the email was sent and see all recipients.",
        "SMS messages are sent automatically for key events (e.g., booking confirmation, payment received) using DLT-registered templates — no manual action needed.",
      ],
      faqs: [
        { question: "What email address do emails come from?", answer: "All CRM emails are sent from 'The WorkVilla <contact@theworkvilla.com>' via Google Workspace SMTP." },
        { question: "Can recipients reply to CRM emails?", answer: "Yes. The reply-to address is set to contact@theworkvilla.com. Replies go to the Google Workspace inbox." },
        { question: "An email was not received. What should I check?", answer: "Ask the recipient to check their spam/junk folder. Also verify the email address was typed correctly. Check the lead's activity timeline to confirm the email was sent successfully from the CRM." },
        { question: "What is DLT-compliant SMS?", answer: "DLT (Distributed Ledger Technology) is TRAI's mandatory framework for commercial SMS in India. All SMS templates used by the CRM are pre-registered with the telecom regulator via MSG91 to ensure deliverability and compliance. These cover 6 key customer communication events." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  22. Payments                                                   */
    /* ============================================================== */
    {
      id: "payments",
      title: "Payments & Razorpay",
      icon: CreditCard,
      overview:
        "The CRM integrates with Razorpay for online payment collection. Payment links can be generated for walk-in bookings and contract payments. When you create or resend a payment link, the system automatically notifies the customer via SMS and/or email based on available contact details, with a confirmation of which channels were used. Payment status updates in real-time — the dialog shows a live breakdown of collected, pending, and balance amounts.",
      workflows: [
        {
          title: "Collecting Payment via Razorpay",
          steps: [
            { step: 1, title: "Find the booking/payment", description: "Open a walk-in booking with 'Pending' payment status." },
            { step: 2, title: "Generate payment link", description: "Click 'Collect Payment' to create a Razorpay payment link." },
            { step: 3, title: "Share with guest", description: "The payment link can be shared via the CRM's email function or copied to clipboard." },
            { step: 4, title: "Payment completed", description: "Once the guest pays through the link, the booking status updates automatically to 'Payment Collected' with a green confirmation banner." },
          ],
        },
      ],
      tips: [
        "Razorpay API keys are configured in Settings by the Admin.",
        "Payment confirmation details (amount, method, Razorpay ID) are shown on the booking page after successful payment.",
        "You can also send payment links for contract payment reminders from the Accounting module.",
        "When you create or resend a payment link, the system confirms which channels (SMS, email) were used to notify the customer.",
        "The payment dialog shows a live breakdown: verified (collected), pending (awaiting), and balance due — it auto-closes when fully paid.",
      ],
      faqs: [
        { question: "What payment methods are supported?", answer: "Razorpay supports UPI, credit/debit cards, net banking, and wallets. The guest chooses their preferred method on the payment page." },
        { question: "How do I know if a payment was successful?", answer: "Successful payments show a green 'Payment Collected' banner on the booking page with the transaction details. The payment status changes from 'Pending' to 'Collected'." },
        { question: "Can I resend a payment link?", answer: "Yes. If a payment link already exists, clicking 'Send Link' again resends notifications via SMS and/or email. The system confirms which channels the resend was attempted on." },
        { question: "What does the live payment breakdown show?", answer: "The payment dialog shows three amounts in real-time: Verified (amount already collected), Pending (amount awaiting completion), and Balance Due (remaining to collect). Once payment reaches the booking total, the dialog auto-closes." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  23. Prepaid Packages                                           */
    /* ============================================================== */
    {
      id: "prepaid-packages",
      title: "Prepaid Packages",
      icon: TicketCheck,
      overview:
        "Prepaid Packages let customers purchase coworking credits in advance at a fixed price. Packages are defined by a credit type — Hours (conference room or desk time), Days (full-day access passes), or Booking Slots (conference room slots for walk-in prepaid members). Each package has a name, location, workspace type, total credits, price, and validity period. When a customer purchases a package, their credit balance is tracked and deducted as they use the space.",
      workflows: [
        {
          title: "Creating a Prepaid Package",
          steps: [
            { step: 1, title: "Go to Prepaid Packages", description: "Navigate to Prepaid Packages from the sidebar." },
            { step: 2, title: "Click 'New Package'", description: "Click the create button to define a new package." },
            { step: 3, title: "Fill in details", description: "Enter the package name, description, location, workspace type, credit type (Hours/Days/Booking Slots), total credits, price, and validity period (in days)." },
            { step: 4, title: "Save", description: "Save the package. It is now available to assign to customers." },
          ],
        },
        {
          title: "Selling a Package to a Customer",
          steps: [
            { step: 1, title: "Open a package", description: "Click on a package from the list to open its detail page." },
            { step: 2, title: "Click 'New Purchase'", description: "Click the 'New Purchase' button to assign this package to a customer." },
            { step: 3, title: "Select the customer", description: "Choose an existing lead from the system, or enter the customer's details." },
            { step: 4, title: "Collect payment", description: "Record the payment method (cash, UPI, Razorpay link, etc.) and mark as paid." },
            { step: 5, title: "Confirm purchase", description: "The purchase is created and the customer's credit balance is set. Credits begin counting from the purchase date." },
          ],
        },
        {
          title: "Tracking Credit Usage",
          steps: [
            { step: 1, title: "Open the purchase", description: "Find the customer's purchase in the package or purchases list." },
            { step: 2, title: "View balance", description: "The purchase shows total credits, credits used, and remaining credits with a progress bar." },
            { step: 3, title: "Credits deducted on use", description: "Each booking or check-in linked to this purchase automatically deducts from the balance." },
          ],
        },
      ],
      tips: [
        "Use 'Booking Slots' credit type for walk-in prepaid members who pre-purchase a set number of conference room bookings.",
        "Use 'Hours' credit type for customers who buy bulk hourly coworking time.",
        "Use 'Days' credit type for customers purchasing multi-day access passes.",
        "Set a validity period to ensure credits expire — this encourages timely usage.",
        "The package detail page shows all purchases linked to that package.",
      ],
      faqs: [
        { question: "What are the credit types?", answer: "Hours: credits represent hours of space usage. Days: credits represent full-day access passes. Booking Slots: credits represent individual conference room booking slots, ideal for walk-in prepaid members." },
        { question: "What happens when credits expire?", answer: "Expired credits can no longer be used for new bookings. The purchase status shows as 'Expired'. Unused credits are not automatically refunded." },
        { question: "Can I top up a customer's credits?", answer: "Yes. Create a new purchase for the same package. Each purchase has its own credit balance and expiry date." },
        { question: "How do Booking Slots get deducted?", answer: "When you create a booking for a prepaid package customer and select their purchase, one Booking Slot is deducted from their balance automatically." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  24. Support Tickets                                            */
    /* ============================================================== */
    {
      id: "support-tickets",
      title: "Support Tickets",
      icon: LifeBuoy,
      overview:
        "Support Tickets track internal issues, customer complaints, and maintenance requests. Any staff member can create a ticket and track their own tickets via the 'My Tickets' view. Each ticket is auto-numbered (TWV-T-XXXX) and has a subject, type, priority, status, reporter, and assignee. Admins and Managers triage and resolve tickets. If a resolved or closed ticket needs further attention, the ticket owner (creator) can reopen it. Email notifications are sent automatically when a ticket is updated, keeping all stakeholders informed. This module keeps issues visible and accountable.",
      workflows: [
        {
          title: "Creating a Support Ticket",
          steps: [
            { step: 1, title: "Go to Support", description: "Navigate to Support Tickets from the sidebar." },
            { step: 2, title: "Click 'New Ticket'", description: "Click the create button to open the new ticket form." },
            { step: 3, title: "Fill in details", description: "Enter a subject, select the ticket type (Maintenance, Customer Issue, IT, etc.), and set priority (Low, Medium, High, Urgent)." },
            { step: 4, title: "Describe the issue", description: "Add a detailed description of the problem in the notes field." },
            { step: 5, title: "Assign", description: "Optionally assign the ticket to a specific team member. Unassigned tickets appear in the triage queue." },
            { step: 6, title: "Submit", description: "Save the ticket. It will appear in the ticket list with status 'Open'." },
          ],
        },
        {
          title: "Managing and Resolving Tickets",
          steps: [
            { step: 1, title: "Review the ticket list", description: "Filter tickets by status (Open, In Progress, Resolved, Closed), priority, or type." },
            { step: 2, title: "Assign and update status", description: "Click a ticket to open it. Update the assignee and change the status to 'In Progress' when work begins." },
            { step: 3, title: "Add notes", description: "Log progress updates and communications in the notes section." },
            { step: 4, title: "Resolve or close", description: "Set status to 'Resolved' when fixed, then 'Closed' after confirmation from the reporter." },
          ],
        },
        {
          title: "Tracking Your Own Tickets (My Tickets)",
          steps: [
            { step: 1, title: "Open 'My Tickets'", description: "Switch to the 'My Tickets' tab on the Support Tickets page to see only tickets you created." },
            { step: 2, title: "Monitor status", description: "Track the progress of your reported issues — you can see when they move from Open to In Progress to Resolved." },
            { step: 3, title: "Reopen if needed", description: "If a ticket was marked Resolved or Closed but the issue persists, click 'Reopen'. The ticket returns to Open status and the assignee is notified." },
          ],
        },
      ],
      tips: [
        "Use 'Urgent' priority for issues affecting current customers or operations — these show at the top of the list.",
        "Add detailed notes when closing a ticket so there is a record of how the issue was resolved.",
        "Tickets are numbered sequentially (TWV-T-0001, TWV-T-0002, …) making them easy to reference in conversations.",
        "Any team member can create tickets — encourage staff to report issues immediately rather than verbally.",
        "Use 'My Tickets' to track the status of issues you reported without digging through the full ticket list.",
        "As the ticket creator, you can reopen a Resolved or Closed ticket if the issue was not fully fixed.",
        "Email notifications are sent automatically when a ticket status changes or a note is added — no need to manually notify stakeholders.",
      ],
      faqs: [
        { question: "Who can see support tickets?", answer: "All authenticated team members can view tickets. Any staff member can create one. Admins and Managers can assign, update, and close tickets." },
        { question: "Can I reopen a ticket that was marked resolved?", answer: "Yes. If you are the ticket creator (owner), you will see a 'Reopen' option on Resolved and Closed tickets. This lets you flag that the issue needs further attention." },
        { question: "What is 'My Tickets'?", answer: "My Tickets is a self-service view that shows only the tickets you personally created. Every role has access to it, making it easy to track your own reported issues without seeing the full ticket queue." },
        { question: "Can I link a ticket to a lead or booking?", answer: "Tickets can reference any context in their description. Direct linking to other entities is via ticket notes." },
        { question: "What ticket types are available?", answer: "Common types include Maintenance, IT Issue, Customer Complaint, Billing Query, and General. The exact list may vary based on your configuration." },
        { question: "Do I get notified when my ticket is updated?", answer: "Yes. Email notifications are sent automatically when a ticket status changes or notes are added. The ticket reporter, assignee, and relevant managers all receive updates." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  25. Procurement                                                */
    /* ============================================================== */
    {
      id: "procurement",
      title: "Procurement",
      icon: ShoppingCart,
      overview:
        "The Procurement module manages the full purchasing lifecycle for The WorkVilla — from vendor management and item catalogues through purchase requests, purchase orders (goods and services), delivery receipts, vendor bills, and bill approvals. It provides visibility into what is being ordered, from whom, and at what cost, enabling better control over operational expenses. Service POs support recurring billing cycles and per-cycle invoicing.",
      workflows: [
        {
          title: "Adding a Vendor",
          steps: [
            { step: 1, title: "Go to Procurement → Vendors", description: "Navigate to Procurement from the sidebar and select the Vendors tab." },
            { step: 2, title: "Click 'New Vendor'", description: "Click the create button and fill in the vendor name, contact details, category, and payment terms." },
            { step: 3, title: "Save", description: "The vendor is now available when creating purchase orders and bills." },
          ],
        },
        {
          title: "Creating a Purchase Request",
          steps: [
            { step: 1, title: "Go to Purchase Requests", description: "Navigate to Procurement → Purchase Requests." },
            { step: 2, title: "Click 'New Request'", description: "Describe the items needed, quantity, estimated cost, and the reason for the purchase." },
            { step: 3, title: "Submit for approval", description: "Submit the request. A Manager or Admin reviews and approves or rejects it." },
            { step: 4, title: "Approved request", description: "Once approved, a Purchase Order can be raised against the request." },
          ],
        },
        {
          title: "Raising a Goods Purchase Order",
          steps: [
            { step: 1, title: "Go to Purchase Orders", description: "Navigate to Procurement → Purchase Orders." },
            { step: 2, title: "Create from request", description: "Click 'New PO', select type 'Goods', and optionally link to an approved purchase request. Select the vendor and add line items." },
            { step: 3, title: "Send to vendor", description: "Generate the PO document and send it to the vendor. The PO status moves to 'Sent'." },
            { step: 4, title: "Record delivery receipt", description: "When goods arrive, create a Delivery Receipt against the PO. Enter received quantities for each line item." },
            { step: 5, title: "Raise vendor bill", description: "After recording a delivery receipt, a vendor bill can be raised. The system enforces that the bill amount cannot exceed the proportionate value of goods received." },
          ],
        },
        {
          title: "Raising a Service Purchase Order",
          steps: [
            { step: 1, title: "Create a Service PO", description: "Click 'New PO' and select type 'Service'. Enter the service description, total value, billing cycle (monthly, quarterly, etc.), and number of cycles." },
            { step: 2, title: "Track billing cycles", description: "Each billing cycle is listed on the PO. Mark cycles as completed when the service period is done." },
            { step: 3, title: "Upload service reports", description: "Attach service completion reports or delivery proof for each cycle." },
            { step: 4, title: "Raise per-cycle invoices", description: "Create a vendor bill for each completed billing cycle. The bill amount is capped at the cycle value." },
          ],
        },
        {
          title: "Recording a Vendor Bill and Getting it Approved",
          steps: [
            { step: 1, title: "Go to Vendor Bills", description: "Navigate to Procurement → Vendor Bills." },
            { step: 2, title: "Create a bill", description: "Link the bill to a Purchase Order. Upload the vendor invoice file. Enter the invoice number, date, and amount. For goods POs with a delivery shortfall, the amount is capped at the proportionate received value." },
            { step: 3, title: "Submit for approval", description: "Submit the bill. A Manager or Admin will review and approve or reject it." },
            { step: 4, title: "Approved → Payment", description: "Once approved, the bill is ready for payment. Mark it as 'Paid' once the vendor is paid." },
          ],
        },
      ],
      tips: [
        "Maintain an Item Catalogue with standard items and prices to speed up PO creation.",
        "Purchase Requests create a paper trail for spending decisions — always use them for non-routine purchases.",
        "A vendor bill cannot be created against a goods PO until at least one delivery receipt has been recorded.",
        "If a delivery shortfall exists (received qty < ordered qty), the bill amount is automatically capped at the proportionate received value. An inline error appears if you enter a higher amount.",
        "Service POs support recurring billing cycles — create one PO for an annual contract and track each month or quarter as a separate cycle.",
        "Filter vendor bills by status to quickly see what payments are due.",
        "Link Purchase Orders to approved requests for complete traceability from request to payment.",
      ],
      faqs: [
        { question: "Who can approve purchase requests and vendor bills?", answer: "Managers and Admins can approve or reject purchase requests and vendor bills. Sales Reps and Floor Managers can create requests but cannot approve them." },
        { question: "Can I create a PO without a purchase request?", answer: "Yes. For routine or emergency purchases, you can create a Purchase Order directly without linking to a request." },
        { question: "What is the Item Catalogue?", answer: "A reusable list of standard items (cleaning supplies, stationery, furniture, etc.) with standard descriptions and prices. Using catalogue items speeds up PO and bill creation and ensures consistent item naming." },
        { question: "Why can't I create a vendor bill for my goods PO?", answer: "A vendor bill requires at least one delivery receipt to be recorded first. Record the goods received (even a partial delivery) before creating the bill." },
        { question: "Why is the bill amount limited?", answer: "If fewer goods were delivered than ordered (a shortfall), the bill is capped at the proportionate value of what was actually received. For example, if 60% of goods were delivered, the bill cannot exceed 60% of the PO value. This protects against overpayment for undelivered goods." },
        { question: "What is a Service PO?", answer: "A Service PO is for recurring or contracted services (e.g., housekeeping, security, internet). It is structured around billing cycles (monthly, quarterly, etc.) and allows you to raise a separate invoice for each cycle as the service is delivered, rather than paying the full amount upfront." },
      ],
      roles: ["admin", "manager"],
    },

    /* ============================================================== */
    /*  26. Cases                                                      */
    /* ============================================================== */
    {
      id: "cases",
      title: "Cases",
      icon: Briefcase,
      overview:
        "Cases manage Virtual Office and membership service workflows. Each case tracks a client service request from initiation to completion — including document collection, proposal generation, Leave & License agreement execution, and service delivery milestones. Cases are managed in a list or detail view, moving through stages as work progresses. Each case has dedicated tabs: Overview, Documents, Compliance, Proposal, Agreement, Comments, and Emails. Documents show who reviewed them and when. Subscription history tracks all periods with renewal support.",
      workflows: [
        {
          title: "Creating a Case",
          steps: [
            { step: 1, title: "Go to Cases", description: "Navigate to Cases from the sidebar under Virtual Offices." },
            { step: 2, title: "Click 'Create Case'", description: "Click the create button and fill in client details, purpose, rate, and tenure." },
            { step: 3, title: "Link to a client", description: "Select the client this case is for. Their contact details are pre-filled." },
            { step: 4, title: "Save", description: "The case is created and you are taken to the case detail page." },
          ],
        },
        {
          title: "Generating a Proposal (Proposal Tab)",
          steps: [
            { step: 1, title: "Open the Proposal tab", description: "Navigate to a case and click the 'Proposal' tab." },
            { step: 2, title: "Click 'Generate Proposal'", description: "Click the button to auto-generate a proposal PDF from the case details (rate, tenure, purpose, client info)." },
            { step: 3, title: "Review and edit", description: "View the generated PDF. Click 'Edit Proposal' to adjust variables like rate, tenure, or start date, then regenerate." },
            { step: 4, title: "Approve and send", description: "Move the proposal through statuses: Draft → Internally Approved → Sent to Client → Client Approved." },
          ],
        },
        {
          title: "Generating a Leave & License Agreement (Agreement Tab)",
          steps: [
            { step: 1, title: "Open the Agreement tab", description: "Navigate to a case and click the 'Agreement' tab." },
            { step: 2, title: "Click 'Generate Agreement'", description: "Click to auto-generate a Leave & License agreement PDF with 12 legal clauses, schedule, and signature blocks." },
            { step: 3, title: "Edit agreement details", description: "Click 'Edit Agreement' to fill in nature of business, lessee signatory name/designation, witness details (names and last 4 digits of Aadhaar), and e-stamp value." },
            { step: 4, title: "Approve and execute", description: "Move through statuses: Draft → Internally Approved → Sent to Client → Client Approved → Signing → Executed." },
            { step: 5, title: "Initiate e-stamping & signing", description: "Once client-approved, click 'Initiate E-Stamping & Signing' to send the agreement for digital execution via Leegality (e-stamp paper + Aadhaar eSign)." },
          ],
        },
        {
          title: "Uploading and Reviewing Documents",
          steps: [
            { step: 1, title: "Open the Documents tab", description: "Navigate to a case and click the Documents tab." },
            { step: 2, title: "Upload files", description: "Upload KYC documents, agreements, or any supporting files. Common formats (PDF, images) are supported." },
            { step: 3, title: "Review documents", description: "When a document is reviewed, the reviewer's name and timestamp are displayed on the document card." },
          ],
        },
        {
          title: "Renewing a Subscription",
          steps: [
            { step: 1, title: "Check subscription status", description: "On the case Overview tab, the Subscription History table shows all periods with expiry countdown (green >30 days, amber ≤30 days, red for expired)." },
            { step: 2, title: "Click 'Renew'", description: "When a subscription is active or renewal-due, click the 'Renew' button. A renewal alert banner also appears when expiry is within 60 days." },
            { step: 3, title: "Confirm renewal details", description: "You are taken to the case creation form pre-filled with the current case details. Adjust rate, tenure, or start date as needed." },
            { step: 4, title: "Save", description: "The new renewal case is created and linked to the original, marked with a '(renewal)' label." },
          ],
        },
      ],
      tips: [
        "The case detail page has 7 tabs: Overview, Documents, Compliance, Proposal, Agreement, Comments, and Emails.",
        "The Proposal tab generates a commercial proposal PDF; the Agreement tab generates a formal Leave & License agreement — they are separate stages.",
        "Document cards show the reviewer's name and review timestamp so you can track who verified each document.",
        "The Subscription History table on Overview shows all subscription periods with color-coded expiry countdowns.",
        "A renewal alert banner appears automatically when a subscription expires within 60 days — click 'Renew Now' to start the renewal.",
        "Leave & License agreements include 12 legal clauses, a schedule table, annexure, witness section, and required documents list based on entity type.",
        "Attach all client KYC documents directly to the case to keep everything in one place.",
      ],
      faqs: [
        { question: "What is the difference between the Proposal tab and the Agreement tab?", answer: "The Proposal tab generates a commercial offer (pricing, workspace details). The Agreement tab generates a formal Leave & License legal agreement with clauses, schedules, and signature blocks. Typically, you create a Proposal first, then generate the Agreement after the client accepts." },
        { question: "How does the Leave & License agreement e-stamping work?", answer: "Once the agreement is client-approved, click 'Initiate E-Stamping & Signing'. This sends the PDF to Leegality for Tamil Nadu e-stamp paper (via BharatStamp) and Aadhaar-based digital signatures. You can track the signing status from the Agreement tab." },
        { question: "Can I attach multiple documents to a single case?", answer: "Yes. The Documents tab within a case supports multiple file uploads. Each file can be categorized and shows reviewer name and timestamp when reviewed." },
        { question: "How does subscription renewal work?", answer: "The Overview tab shows a Subscription History table with all periods. When a subscription nears expiry (within 60 days), a renewal alert banner appears. Click 'Renew' to create a new case pre-filled with the current details. Renewal cases are marked with '(renewal)' in the case list." },
        { question: "How is a case different from a contract?", answer: "A Contract formalizes the ongoing billing relationship. A Case tracks the service delivery workflow — especially document collection, proposal, agreement signing, and onboarding steps — that happens before and alongside the contract." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  27. Aggregators                                                */
    /* ============================================================== */
    {
      id: "aggregators",
      title: "Aggregators",
      icon: Handshake,
      overview:
        "Aggregators are partner platforms or brokers (e.g., JustCoWork, Workinton, COWRKS) that send coworking bookings to The WorkVilla on behalf of their customers. The Aggregators module tracks each partner, their rate cards (special pricing agreements), key contacts, and booking history. This helps manage partner relationships and ensures correct billing for aggregator-sourced bookings.",
      workflows: [
        {
          title: "Adding an Aggregator",
          steps: [
            { step: 1, title: "Go to Aggregators", description: "Navigate to Aggregators from the sidebar." },
            { step: 2, title: "Click 'New Aggregator'", description: "Click the create button and enter the aggregator's name, website, and contact details." },
            { step: 3, title: "Add contacts", description: "Add the primary contact person(s) at the aggregator with their name, email, and phone." },
            { step: 4, title: "Set rate card", description: "Configure the agreed pricing or commission rate for this partner." },
            { step: 5, title: "Save", description: "The aggregator is now available as a booking source." },
          ],
        },
        {
          title: "Managing Rate Cards",
          steps: [
            { step: 1, title: "Open the aggregator", description: "Click on an aggregator from the list to open their detail page." },
            { step: 2, title: "Go to Rate Cards tab", description: "Switch to the Rate Cards tab to see the current pricing agreement." },
            { step: 3, title: "Add or update rates", description: "Add rates per space type or day/hour. Rates can differ from the standard walk-in price." },
            { step: 4, title: "Save", description: "Updated rates apply to new aggregator bookings." },
          ],
        },
      ],
      tips: [
        "Keep rate cards current — expired or missing rates can cause billing errors on aggregator bookings.",
        "Record all contacts at each aggregator so you always know who to reach for billing queries or disputes.",
        "Track which bookings were sourced through an aggregator to measure partner performance.",
        "Aggregators typically have different pricing from walk-in rates — always verify the rate card before confirming prices.",
      ],
      faqs: [
        { question: "Who can manage aggregators?", answer: "Admins and Managers have full access to create and edit aggregators and rate cards. Sales Reps can view aggregator details but cannot modify them." },
        { question: "How do aggregator bookings differ from regular walk-in bookings?", answer: "Aggregator bookings are sourced through a partner platform. The guest pays the aggregator, not The WorkVilla directly. The rate card determines the settlement amount The WorkVilla receives from the aggregator." },
        { question: "Can I track bookings by aggregator?", answer: "Yes. Bookings can be tagged with an aggregator source. Filter the Bookings list by aggregator to see all partner-sourced bookings and their revenue." },
      ],
      roles: ["admin", "manager"],
    },

    /* ============================================================== */
    /*  28. Petty Cash                                                 */
    /* ============================================================== */
    {
      id: "petty-cash",
      title: "Petty Cash",
      icon: Wallet,
      overview:
        "The Petty Cash module manages small operational expenses across the team. Each team member gets a personal petty cash book (auto-created on first access) that tracks their balance, funding requests, and expenses. Expenses go through a multi-level approval workflow: expenses under ₹5,000 need manager approval only, while those ₹5,000 and above require both manager and admin approval. Rejected expenses can be edited and resubmitted. Admins and Managers can view all books, spending breakdowns by category, and timeline-filtered analytics. Approved funding requests appear on the Accounting page for the accounts team to issue payment.",
      workflows: [
        {
          title: "Requesting Petty Cash Funds",
          steps: [
            { step: 1, title: "Go to Petty Cash", description: "Navigate to Petty Cash from the sidebar under Finance." },
            { step: 2, title: "View your book", description: "The 'My Book' view shows your current balance and recent activity. A personal book is auto-created on first access." },
            { step: 3, title: "Submit a funding request", description: "Click 'Request Funds', enter the amount and purpose, then submit. The request goes to an Admin/Manager for approval." },
            { step: 4, title: "Funds issued", description: "Once approved, the request moves to Accounting for the accounts team to issue payment. Your book balance increases when funds are issued." },
          ],
        },
        {
          title: "Logging an Expense",
          steps: [
            { step: 1, title: "Open your book", description: "Go to Petty Cash → My Book." },
            { step: 2, title: "Click 'Add Expense'", description: "Enter the date, amount, category, and description of the expense." },
            { step: 3, title: "Submit", description: "The expense enters the approval workflow. Under ₹5,000 needs manager approval only. ₹5,000 and above needs both manager and admin approval." },
            { step: 4, title: "Approved", description: "Once fully approved, the expense amount is deducted from your book balance." },
          ],
        },
        {
          title: "Editing and Resubmitting a Rejected Expense",
          steps: [
            { step: 1, title: "Find the rejected expense", description: "In your book, rejected expenses show a rejection reason in a highlighted box." },
            { step: 2, title: "Click 'Edit & Resubmit'", description: "Click the button on the rejected entry to modify the date, amount, category, or description." },
            { step: 3, title: "Resubmit", description: "Save changes. The expense returns to 'Pending Manager' status and goes through the approval cycle again." },
          ],
        },
        {
          title: "Approving Expenses and Requests (Manager/Admin)",
          steps: [
            { step: 1, title: "Go to Approvals tab", description: "Navigate to Petty Cash → Approvals (visible to Managers and Admins)." },
            { step: 2, title: "Review fund requests", description: "The Fund Requests tab shows pending requests with the requester's name and current balance. Approve or reject with optional notes." },
            { step: 3, title: "Review expenses", description: "The Expense Approvals tab shows pending expenses. Review the entry details, category, and amount before approving or rejecting." },
          ],
        },
        {
          title: "Viewing All Books (Admin/Manager)",
          steps: [
            { step: 1, title: "Go to All Books tab", description: "Navigate to Petty Cash → All Books to see all team members' petty cash books." },
            { step: 2, title: "Click a book", description: "Click any person's book to see their detailed view with balance, spending, and funding history." },
            { step: 3, title: "Use timeline presets", description: "Filter the detail view by 'This Week', 'This Month', or 'This Year' to see spending and funding for specific periods." },
            { step: 4, title: "Review category breakdown", description: "The 'Spend by Category' section shows a visual bar chart of how expenses are distributed across categories." },
          ],
        },
      ],
      tips: [
        "Expenses under ₹5,000 need only manager approval. ₹5,000+ requires both manager and admin sign-off.",
        "Rejected expenses can be edited and resubmitted — the rejection reason is shown so you know what to fix.",
        "The All Books view shows 'Total Float Outstanding' across all petty cash books at the top.",
        "Use timeline presets (This Week / This Month / This Year) in the detailed book view to analyze spending over specific periods.",
        "The 'Spend by Category' visual breakdown helps identify where money is being spent most.",
        "Approved funding requests automatically appear on the Accounting page's Action Required banner for the accounts team to issue payment.",
      ],
      faqs: [
        { question: "What is the approval threshold?", answer: "Expenses under ₹5,000 require manager approval only. Expenses of ₹5,000 or more require both manager approval first, then admin approval. This two-tier system ensures oversight on larger expenses." },
        { question: "Can I resubmit a rejected expense?", answer: "Yes. Click 'Edit & Resubmit' on the rejected entry. You can modify the details and the expense re-enters the approval workflow from the beginning." },
        { question: "How do I get my petty cash book?", answer: "Your personal petty cash book is automatically created the first time you access the Petty Cash module. No setup needed." },
        { question: "Where do approved fund requests go?", answer: "Approved requests appear on the Accounting page's Action Required banner under 'Issue Cash'. The accounts team processes the payment and marks it as issued, which increases your book balance." },
        { question: "Can Managers see everyone's expenses?", answer: "Yes. Managers and Admins can view the All Books tab to see all team members' books, balances, and spending history with category breakdowns." },
      ],
      roles: null,
    },
  ],

  /* ================================================================ */
  /*  Global FAQs                                                      */
  /* ================================================================ */

  globalFaqs: [
    { question: "How do I reset my password?", answer: "Click 'Forgot Password' on the login page and enter your email. You will receive a password reset link. Alternatively, ask your Admin to reset your password from the Team module." },
    { question: "Can multiple people use the CRM at the same time?", answer: "Yes. The CRM supports concurrent users. Each user has their own login and sees data based on their role." },
    { question: "Is my data secure?", answer: "Yes. The CRM uses Supabase (PostgreSQL) with Row Level Security, HTTPS encryption, and role-based access control. All changes are tracked in audit logs." },
    { question: "Can I export data from the CRM?", answer: "Accounting summaries can be exported. Individual records (leads, bookings, etc.) can be printed or saved as PDFs. Bulk CSV export is not currently available." },
    { question: "What browsers are supported?", answer: "The CRM works best on Chrome, Firefox, Safari, and Edge (latest versions). Mobile browsers are also supported." },
    { question: "How do I report a bug or request a feature?", answer: "Contact the admin team at contact@theworkvilla.com with a description of the issue or feature request." },
    { question: "What happens if the internet goes down?", answer: "The CRM requires an active internet connection. If you lose connection, unsaved changes may be lost. We recommend saving frequently." },
    { question: "Can I undo a change?", answer: "There is no undo button. However, Admins can review the Audit Logs to see what changed and manually reverse it if needed." },
    { question: "Why can I not see certain modules in the sidebar?", answer: "Your access is determined by your role. Sales Reps have limited access. Managers and Admins see additional modules. Ask your Admin to check your role if you believe access is incorrect." },
    { question: "How do I contact support?", answer: "Email contact@theworkvilla.com or call +91 97910 97900 during business hours." },
  ],

  /* ================================================================ */
  /*  Keyboard shortcuts                                               */
  /* ================================================================ */

  keyboardShortcuts: [
    { keys: ["Cmd", "K"], description: "Open the command palette to search pages and leads (Ctrl+K on Windows)" },
    { keys: ["Escape"], description: "Close the command palette, dialogs, and modal windows" },
    { keys: ["↑", "↓"], description: "Navigate through search results in the command palette" },
    { keys: ["Enter"], description: "Select the highlighted result in the command palette" },
  ],

  /* ================================================================ */
  /*  Role permissions matrix                                          */
  /* ================================================================ */

  rolePermissions: [
    { feature: "Dashboard", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Leads (own)", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Leads (all)", admin: true, manager: true, sales_rep: false, floor_manager: false },
    { feature: "Pipeline", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Activities", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Tasks", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Proposals", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Invoices", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Contracts", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Billing", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Accounting", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Lock/Unlock Periods", admin: true, manager: true, sales_rep: false, floor_manager: false },
    { feature: "Spaces", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Bookings", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Documents", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Vouchers", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Prepaid Packages (view/sell)", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Prepaid Packages (create/edit)", admin: true, manager: true, sales_rep: false, floor_manager: false },
    { feature: "Support Tickets (create)", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Support Tickets (manage/close)", admin: true, manager: true, sales_rep: false, floor_manager: false },
    { feature: "Procurement (view)", admin: true, manager: true, sales_rep: false, floor_manager: false },
    { feature: "Procurement (approve/PO/bills)", admin: true, manager: true, sales_rep: false, floor_manager: false },
    { feature: "Petty Cash (view own book)", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Petty Cash (approve)", admin: true, manager: true, sales_rep: false, floor_manager: false },
    { feature: "Petty Cash (all books)", admin: true, manager: true, sales_rep: false, floor_manager: false },
    { feature: "Cases", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Aggregators", admin: true, manager: true, sales_rep: false, floor_manager: false },
    { feature: "Locations", admin: true, manager: true, sales_rep: false, floor_manager: false },
    { feature: "Audit Logs", admin: true, manager: true, sales_rep: false, floor_manager: false },
    { feature: "Infrastructure", admin: true, manager: false, sales_rep: false, floor_manager: false },
    { feature: "Settings", admin: true, manager: false, sales_rep: false, floor_manager: false },
    { feature: "Team Management", admin: true, manager: true, sales_rep: true, floor_manager: false },
    { feature: "Create/Edit Users", admin: true, manager: false, sales_rep: false, floor_manager: false },
    { feature: "Delete Records", admin: true, manager: false, sales_rep: false, floor_manager: false },
  ],

  /* ================================================================ */
  /*  Support info                                                     */
  /* ================================================================ */

  supportInfo: {
    email: "contact@theworkvilla.com",
    phone: "+91 97910 97900",
  },
};
