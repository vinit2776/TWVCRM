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
            { step: 1, title: "Use the sidebar", description: "The left sidebar lists all modules. Click any item to navigate." },
            { step: 2, title: "Quick search", description: "Press Cmd+K (or Ctrl+K) to open the command palette. Type a page name or lead name to jump there instantly." },
            { step: 3, title: "Mobile access", description: "On mobile devices, use the bottom navigation bar. Tap 'More' to access additional modules via the sidebar." },
          ],
        },
      ],
      tips: [
        "Bookmark the CRM URL for quick access from your browser.",
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
        "The Dashboard is your home screen. It shows key performance indicators (KPIs) like total leads, conversion rate, tasks due today, and pending follow-ups. It also displays a visual pipeline breakdown and recent team activities. Use the location filter to focus on a specific coworking center.",
      workflows: [
        {
          title: "Reading Your Dashboard",
          steps: [
            { step: 1, title: "Review KPI cards", description: "At the top you will see four metric cards: Total Leads, Conversion Rate, Tasks Due Today, and Pending Follow-ups." },
            { step: 2, title: "Check the pipeline", description: "Below the KPIs you will find the lead pipeline showing counts for each stage — New, Qualified, Proposal Sent, Negotiation, Won, and Lost." },
            { step: 3, title: "View recent activities", description: "The Recent Activities widget shows the last 5 team actions (calls, emails, meetings) with who did what and when." },
            { step: 4, title: "Filter by location", description: "Use the location dropdown at the top to filter all dashboard metrics for a specific coworking center." },
          ],
        },
      ],
      tips: [
        "Check the dashboard first thing each morning to see tasks due and pending follow-ups.",
        "A declining conversion rate may indicate leads are stalling — check the pipeline for bottlenecks.",
        "The pipeline bar chart shows the percentage of leads at each stage, helping identify where most deals are stuck.",
      ],
      faqs: [
        { question: "Why are my dashboard numbers different from my colleague's?", answer: "If you are a Sales Rep, you only see leads and tasks assigned to you. Admins and Managers see data for all team members. Filter by location to narrow the view further." },
        { question: "How often does the dashboard refresh?", answer: "The dashboard fetches fresh data each time you visit the page or refresh your browser. There is no auto-refresh interval." },
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
        "Leads represent potential customers interested in your coworking spaces. Each lead tracks contact details, company information, workspace requirements, and their journey from initial inquiry to becoming a member. You can create, edit, rate, and move leads through statuses as they progress.",
      workflows: [
        {
          title: "Creating a New Lead",
          steps: [
            { step: 1, title: "Click 'New Lead'", description: "Go to the Leads page and click the 'New Lead' button in the top right corner." },
            { step: 2, title: "Fill in contact details", description: "Enter the lead's first name, last name, email, phone, and company. All fields marked with * are required." },
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
        "Use the star rating (1-5) to quickly prioritize high-value leads.",
        "Filter the leads list by status, source, or location to find exactly what you need.",
        "Each lead detail page shows related proposals, contracts, activities, and tasks in separate tabs.",
        "Sales Reps only see their own leads. Managers and Admins see all leads.",
      ],
      faqs: [
        { question: "What do the lead statuses mean?", answer: "New: Just entered the system. Qualified: Confirmed as a real opportunity. Proposal Sent: A proposal has been emailed. Negotiation: Active discussions on terms. Won: Converted to a customer. Lost: Did not convert." },
        { question: "Can I assign a lead to another team member?", answer: "Yes. Open the lead's edit page and change the 'Assigned To' field to another team member. They will then see the lead in their own leads list." },
        { question: "How do I find a specific lead?", answer: "Use the search bar at the top of the leads list to search by name, email, or company. You can also use Cmd+K to search globally." },
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
        "Proposals are formal workspace offers sent to qualified leads. Each proposal is auto-numbered (PROP-XXXX), contains pricing details and workspace specifications, and can be emailed directly to the lead as a PDF attachment from the CRM.",
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
      ],
      tips: [
        "You can add multiple email recipients when sending — add the lead's email plus any additional contacts.",
        "After sending, the proposal status changes to 'Sent' and the lead status updates to 'Proposal Sent'.",
        "Review the PDF preview before sending to ensure formatting is correct.",
        "Proposals that receive no response can be manually set to 'Expired'.",
      ],
      faqs: [
        { question: "Can I edit a proposal after sending it?", answer: "Yes, you can edit the proposal content. However, the previously sent PDF will not update in the recipient's inbox. You would need to re-send the updated version." },
        { question: "What email address are proposals sent from?", answer: "All emails are sent from contact@theworkvilla.com via Google Workspace. Recipients can reply directly to this address." },
        { question: "Can I send a proposal to multiple people?", answer: "Yes. In the email dialog, type each additional email address and press Enter to add them. All recipients will receive the same email with the proposal PDF attached." },
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
        "Use the search and date filters to find contracts by number, lead name, or date range.",
        "Active contracts appear in the Accounting module for monthly billing.",
      ],
      faqs: [
        { question: "What happens when a contract ends?", answer: "When a contract reaches its end date, you can update the status to 'Completed' or create a new contract for renewal." },
        { question: "Can I cancel an active contract?", answer: "Yes. Change the contract status to 'Cancelled'. Note that this does not automatically handle any outstanding payments." },
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
        "The Accounting module provides a monthly financial overview. Select a month and see all contract revenue, walk-in collections, cash handovers, and GST invoices in one place. Periods can be locked after reconciliation to prevent further changes.",
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
        "Summary cards at the top show totals: Billable, Collected, Outstanding, Cash Pending, and Cash Handed Over.",
        "The aging analysis shows current vs 30/60/90-day overdue amounts.",
        "Locked periods display a status bar showing who locked them and when.",
        "GST invoices can be uploaded as PDFs and emailed to clients directly.",
      ],
      faqs: [
        { question: "Can I unlock a locked period?", answer: "Yes. An Admin or Manager can unlock a period to make corrections, then lock it again." },
        { question: "What does the 'Carried Forward' amount mean?", answer: "It represents outstanding balances from previous periods that are still unpaid." },
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
        "Bookings manage conference room and desk reservations. You can create bookings for contract members or walk-in guests. The module supports check-in/check-out workflows, payment collection via Razorpay, feedback collection, and post-visit analytics. View bookings in a list, calendar, or analytics dashboard.",
      workflows: [
        {
          title: "Creating a New Booking",
          steps: [
            { step: 1, title: "Click 'New Booking'", description: "Go to Bookings and click 'New Booking'." },
            { step: 2, title: "Select customer type", description: "Choose 'Member' (for contract holders) or 'Walk-in' (for one-time guests)." },
            { step: 3, title: "Fill in details", description: "Select the space, date, start time, end time, and enter guest information (name, phone, email)." },
            { step: 4, title: "Set payment", description: "The amount is calculated based on duration and hourly rate. Choose the payment method." },
            { step: 5, title: "Confirm", description: "Save the booking. A confirmation email is sent automatically." },
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
      ],
      faqs: [
        { question: "What is the difference between Member and Walk-in bookings?", answer: "Member bookings are for existing contract holders — their details are pre-filled and billing may go through the contract. Walk-in bookings are for one-time guests who pay at the time of booking." },
        { question: "How does Razorpay payment collection work?", answer: "For walk-in bookings with pending payment, click 'Collect Payment' to generate a Razorpay payment link. You can send this link to the guest or process the payment on-site. Once paid, the status updates automatically." },
        { question: "Can I cancel a booking?", answer: "Yes. Open the booking and click 'Cancel'. Cancelled bookings are preserved in history but marked as cancelled." },
        { question: "How does the feedback system work?", answer: "After a guest checks out, you can send them a feedback link via email. The guest rates their experience on a public page (no login required). Feedback scores appear in the booking details and analytics." },
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
        "Vouchers are promotional codes (e.g., WiFi access passes, day passes) that can be issued to leads or customers. The Inventory view shows stock levels by validity period, and you can upload new voucher codes in bulk via PDF. Each voucher has a lifecycle: Available → Issued → Used/Expired/Revoked.",
      workflows: [
        {
          title: "Managing Voucher Inventory",
          steps: [
            { step: 1, title: "Check stock", description: "Go to Vouchers and view the Inventory tab. Cards show available stock by validity period (7-day, 30-day, 90-day, etc.)." },
            { step: 2, title: "Upload new vouchers", description: "Click 'Upload' to import new voucher codes from a PDF file. Set the validity period and location." },
            { step: 3, title: "Issue vouchers", description: "From a lead or contract, issue a voucher to the customer. The voucher status changes to 'Issued'." },
            { step: 4, title: "Track usage", description: "Use the All Vouchers tab to see all voucher codes, their status, and issue dates." },
          ],
        },
      ],
      tips: [
        "Low stock is highlighted with visual warnings on the inventory cards.",
        "Search by voucher code in the All Vouchers tab to quickly check a specific code's status.",
        "Expired vouchers are automatically marked but can be revoked manually if needed.",
      ],
      faqs: [
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
        "The Infrastructure page provides real-time monitoring of the systems powering the CRM. It shows database usage, hosting metrics, email sending quotas, and a breakdown of database table sizes. Use this to ensure the system is healthy and within resource limits.",
      workflows: [
        {
          title: "Monitoring System Health",
          steps: [
            { step: 1, title: "Go to Infrastructure", description: "Navigate to Infrastructure from the sidebar (Admin only)." },
            { step: 2, title: "Review metrics", description: "Check Supabase (database), Vercel (hosting), and Email Service panels for usage levels." },
            { step: 3, title: "Check alerts", description: "Amber (60%+) and red (80%+) indicators flag high resource usage." },
            { step: 4, title: "Refresh data", description: "Click Refresh to fetch the latest metrics. Data is cached for 24 hours." },
          ],
        },
      ],
      tips: [
        "Monitor the database row count to track growth over time.",
        "Email quotas reset daily and monthly. If sending fails, check if the quota is exhausted.",
        "Use the external dashboard links to access Supabase, Vercel, or Email provider consoles directly.",
      ],
      faqs: [
        { question: "What do the color indicators mean?", answer: "Green: Usage is normal (under 60%). Amber: Usage is elevated (60-80%). Red: Usage is high (over 80%) — consider upgrading or optimizing." },
      ],
      roles: ["admin"],
    },

    /* ============================================================== */
    /*  21. Email System                                               */
    /* ============================================================== */
    {
      id: "email-system",
      title: "Email System",
      icon: Mail,
      overview:
        "The CRM sends emails via Google Workspace SMTP using the contact@theworkvilla.com address. Emails are sent for proposals, contracts, invoices, booking confirmations, payment reminders, feedback requests, and vouchers. All sent emails are logged as activities on the lead's timeline.",
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
      ],
      faqs: [
        { question: "What email address do emails come from?", answer: "All CRM emails are sent from 'The WorkVilla <contact@theworkvilla.com>' via Google Workspace SMTP." },
        { question: "Can recipients reply to CRM emails?", answer: "Yes. The reply-to address is set to contact@theworkvilla.com. Replies go to the Google Workspace inbox." },
        { question: "An email was not received. What should I check?", answer: "Ask the recipient to check their spam/junk folder. Also verify the email address was typed correctly. Check the lead's activity timeline to confirm the email was sent successfully from the CRM." },
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
        "The CRM integrates with Razorpay for online payment collection. Payment links can be generated for walk-in bookings and contract payments. When a payment is completed through Razorpay, the booking or payment record updates automatically.",
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
      ],
      faqs: [
        { question: "What payment methods are supported?", answer: "Razorpay supports UPI, credit/debit cards, net banking, and wallets. The guest chooses their preferred method on the payment page." },
        { question: "How do I know if a payment was successful?", answer: "Successful payments show a green 'Payment Collected' banner on the booking page with the transaction details. The payment status changes from 'Pending' to 'Collected'." },
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
