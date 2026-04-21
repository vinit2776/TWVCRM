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
  Bell,
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
  hint?: string; // Friendly callout — shown as a highlighted tip below the description
  screenshot?: string; // Path to a screenshot image, e.g. /help/login.png
}

export interface HelpWorkflow {
  title: string;
  screenshot?: string; // Optional hero screenshot shown above the steps list
  steps: HelpStep[];
}

export interface HelpSection {
  id: string;
  title: string;
  icon: LucideIcon;
  overview: string;
  screenshot?: string; // Optional hero screenshot shown at the top of the section card
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
        "Welcome to The WorkVilla CRM! This is your central hub for managing leads, bookings, contracts, invoices, and daily operations across all coworking locations. It works in any browser and can also be installed on your phone like a regular app (called a PWA). Use the sidebar on the left to navigate between modules, or press Cmd+K to search for anything instantly.",
      workflows: [
        {
          title: "Logging In",
          screenshot: "/help/login.png",
          steps: [
            { step: 1, title: "Open the application", description: "Visit the CRM URL in your browser. You will see The WorkVilla login page with the logo and two fields: Email and Password.", hint: "Bookmark the URL or install it as an app on your phone (see below) so you can open it in one tap next time." },
            { step: 2, title: "Enter your credentials", description: "Type the email address and password provided by your Admin. Then click the green 'Sign In' button.", hint: "If you've forgotten your password, click the 'Forgot password?' link above the password field — a reset link will be emailed to you within a minute." },
            { step: 3, title: "You're in!", description: "After signing in you land on the Dashboard — your home screen showing today's tasks, recent leads, and follow-up reminders.", hint: "The CRM stays signed in for a long time. You won't need to sign in again unless you sign out or clear your browser." },
          ],
        },
        {
          title: "Installing as an App (PWA)",
          steps: [
            { step: 1, title: "Open in Chrome or Safari", description: "On your phone, open the CRM URL in Chrome (Android) or Safari (iPhone)." },
            { step: 2, title: "Add to Home Screen", description: "On Android: tap the three-dot menu → 'Add to Home Screen'. On iPhone: tap the Share icon → 'Add to Home Screen'." },
            { step: 3, title: "Open like a native app", description: "The CRM icon will appear on your home screen. Tap it to open the app full-screen without a browser bar.", hint: "On desktop Chrome, look for the install icon (⊕) in the address bar to install it as a desktop app." },
            { step: 4, title: "Works offline", description: "Once installed, the app caches key pages so you can browse your most recently viewed data even without internet. Changes sync automatically when you reconnect.", hint: "Offline mode is read-only — you need an internet connection to save new records." },
          ],
        },
        {
          title: "Navigating the Application",
          steps: [
            { step: 1, title: "Use the sidebar", description: "The left sidebar organizes modules into collapsible groups: Sales, Finance, Operations, Virtual Offices, Procurement, and Admin. Click any group header to expand or collapse it.", hint: "The active section auto-expands when you navigate to it — you'll always see the current page highlighted in the sidebar." },
            { step: 2, title: "Search the sidebar", description: "Type in the search box at the top of the sidebar to instantly filter menu items across all groups.", hint: "Try typing 'book' to instantly jump to Bookings, or 'proc' for Procurement — no need to scroll." },
            { step: 3, title: "Use the command palette", description: "Press Cmd+K (Ctrl+K on Windows) to open the command palette. Type a page name or lead name to jump anywhere instantly.", hint: "The command palette is the fastest way to navigate — it searches pages, leads, and actions all at once." },
            { step: 4, title: "Mobile navigation", description: "On phones, the sidebar slides in from the left. Tap any item to navigate; the sidebar auto-closes after selection.", hint: "On mobile, a bottom navigation bar gives you quick access to Dashboard, Leads, and Tasks." },
          ],
        },
      ],
      tips: [
        "Install the CRM as a PWA on your phone for the fastest access — it opens full-screen with no browser chrome.",
        "The sidebar search box finds any menu item instantly — great when you're new and don't know where things live.",
        "Cmd+K (Ctrl+K) is the power-user shortcut — search for any page or lead without leaving your current screen.",
        "Your role controls which modules you see. If a module seems missing, check with your Admin.",
        "If you forget your password, use the 'Forgot Password' link on the login page — no need to call admin.",
      ],
      faqs: [
        { question: "How do I change my password?", answer: "Go to Settings from the sidebar, then update your password in the Profile section. If you are locked out, use the Forgot Password link on the login page or ask your admin to reset it for you." },
        { question: "Can I access the CRM on my phone?", answer: "Yes! The app is fully responsive. Install it as a PWA (Progressive Web App) from your phone's browser for the best experience — it runs full-screen like a native app and works partially offline." },
        { question: "What does the Cmd+K shortcut do?", answer: "It opens the Command Palette — a quick search overlay where you can type to find any page, action, or lead. Use arrow keys to navigate results and Enter to select." },
        { question: "What is offline support?", answer: "Once you've installed the CRM as a PWA, it caches recently viewed pages so you can browse them without internet. You'll need a connection to save new records or see live updates." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  1b. What's New                                                 */
    /* ============================================================== */
    {
      id: "whats-new",
      title: "What's New",
      icon: Bell,
      overview:
        "This section highlights the latest features and improvements added to The WorkVilla CRM. Check here when you hear about a new feature — each update is explained in plain language with simple steps to get started.",
      workflows: [
        {
          title: "✨ WhatsApp Document Delivery (April 2025)",
          steps: [
            { step: 1, title: "What it is", description: "You can now send Proposals, Proforma Invoices, and GST Invoices directly to a customer's WhatsApp as a PDF — in addition to email." },
            { step: 2, title: "How to use it", description: "Click 'Email' on any Proposal, Invoice, or GST Invoice. In the dialog that opens, look for the green 'Also send via WhatsApp' checkbox at the bottom. Tick it, then click Send.", hint: "The checkbox only appears if the lead has a phone number saved. Make sure the lead's phone is filled in." },
            { step: 3, title: "Is it automatic?", description: "No. The checkbox is OFF by default. WhatsApp will never be used unless you tick it. This is completely your choice each time you send.", hint: "Use it for clients who respond faster on WhatsApp than email — great for GST invoice delivery and payment follow-up." },
          ],
        },
        {
          title: "🔔 Real-Time Enquiry Notifications (April 2025)",
          steps: [
            { step: 1, title: "What it is", description: "A notification bell (🔔) is now visible in the top bar on every page. It lights up with a red badge whenever a new lead arrives from Google Ads, Meta Ads, or the Walk-in form — and when you receive a WhatsApp message." },
            { step: 2, title: "How to use it", description: "Click the bell icon to see a list of new enquiries and incoming WhatsApp messages. Click any row to jump straight to the related lead.", hint: "A chime sound plays when a new lead arrives so you can act immediately even without looking at the screen." },
            { step: 3, title: "WhatsApp inbound messages", description: "When a customer messages your WhatsApp Business number, it appears in the bell dropdown under 'WhatsApp'. Click it to see a preview and go to the matched lead.", hint: "If no lead is matched, the customer may be new — create a lead for them so their inquiry is tracked." },
          ],
        },
      ],
      tips: [
        "The WhatsApp checkbox is off by default — you decide when to use it.",
        "Make sure leads have a phone number saved, otherwise the WhatsApp option won't appear.",
        "The notification bell works on all pages — you don't need to stay on the Dashboard.",
        "Mute/unmute your device to control the new-lead chime sound.",
      ],
      faqs: [
        { question: "Where is the WhatsApp checkbox?", answer: "It appears in the email send dialog when you click 'Email' on a Proposal, Proforma Invoice, or GST Invoice — at the bottom, just above the Cancel/Send buttons. It only shows if the lead has a phone number." },
        { question: "Does the notification bell show notifications from the past?", answer: "Yes, it shows recent unread enquiries from the current session and the last few hours. Older notifications are dismissed once you've viewed the lead." },
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
        "The Dashboard is your home screen. It shows key performance indicators (KPIs) like total leads, conversion rate, tasks due today, and pending follow-ups. A Follow-ups widget highlights overdue and upcoming follow-up actions so nothing slips through. Recent team activities are shown in a live feed. Use the location filter to focus on a specific coworking center. A live notification bell (🔔) at the top of the screen alerts you instantly when a new lead arrives from Google Ads, Meta Ads, or Walk-in forms — and shows incoming WhatsApp messages. Admins can configure which widgets are visible for each role.",
      workflows: [
        {
          title: "Reading Your Dashboard",
          steps: [
            { step: 1, title: "Review KPI cards", description: "At the top you will see metric cards: Total Leads, Conversion Rate, Tasks Due Today, and Pending Follow-ups.", hint: "Hover over any KPI card for a tooltip explaining exactly what is counted. Click to jump to the relevant list." },
            { step: 2, title: "Check the Follow-ups widget", description: "The Follow-ups widget lists up to 10 leads with overdue or upcoming follow-up actions, sorted by urgency. Scroll within the widget if there are more.", hint: "Overdue follow-ups show in red — tackle these first thing every morning so no lead slips." },
            { step: 3, title: "Check the Recent Leads widget", description: "The Recent Leads widget shows the last 10 leads added to the system with their current status and latest activity at a glance.", hint: "Click any lead row to open their full detail page directly." },
            { step: 4, title: "View recent activities", description: "The Recent Activities feed shows the last team actions (calls, emails, meetings, notes) with who did what and when.", hint: "This is a live feed — refresh the page to see the very latest team activity." },
            { step: 5, title: "Filter by location", description: "Use the location dropdown at the top to filter all dashboard metrics for a specific coworking center.", hint: "If you manage one location, set the filter as your default to keep the view focused on your center." },
          ],
        },
        {
          title: "Real-Time Enquiry Notifications (New 🔔)",
          steps: [
            { step: 1, title: "Spot the bell icon", description: "Look for the 🔔 bell icon in the top navigation bar (top-right corner of every page). A red badge appears on it whenever there are new unread alerts.", hint: "The bell is always visible — you don't need to be on the Dashboard to see new lead alerts." },
            { step: 2, title: "Click the bell to see alerts", description: "Click the bell icon to open a dropdown. It shows two sections: 'New Enquiries' (fresh leads from Google Ads, Meta Ads, or Walk-in forms) and 'WhatsApp Messages' (incoming customer WhatsApp messages).", hint: "A chime sound plays when a new lead arrives so you don't miss it even when focused on another task." },
            { step: 3, title: "Click an enquiry to open the lead", description: "Click any row in the dropdown to jump straight to that lead's detail page. The alert is automatically dismissed once you view it.", hint: "Act on new enquiries quickly — leads are more likely to convert if contacted within the first few minutes of inquiry." },
            { step: 4, title: "WhatsApp inbound messages", description: "The 'WhatsApp' section in the bell dropdown shows messages sent to your WhatsApp business number. Each shows a preview and links to the related lead (if matched).", hint: "If a WhatsApp message doesn't link to a lead, the customer may be new — create a lead for them manually." },
          ],
        },
        {
          title: "Configuring Dashboard Widgets per Role (Admin only)",
          steps: [
            { step: 1, title: "Go to Settings → Dashboard Widgets", description: "Navigate to Settings from the sidebar and find the Dashboard Widgets configuration section.", hint: "Only Admins can see this section in Settings." },
            { step: 2, title: "Select a role", description: "Choose the role you want to configure: Admin, Manager, Sales Rep, or Floor Incharge.", hint: "Each role gets its own widget layout — a Sales Rep dashboard can look completely different from an Admin's." },
            { step: 3, title: "Toggle widgets on or off", description: "Enable or disable individual widgets (KPIs, Follow-ups, Recent Leads, Pipeline Chart, etc.) for the selected role. Changes take effect immediately.", hint: "The dashboard uses a masonry layout — widgets automatically fill available space so there are no gaps." },
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
        { question: "What is the notification bell?", answer: "The bell icon (🔔) in the top navigation bar shows real-time alerts for new leads arriving from Google Ads, Meta Ads, or Walk-in forms, and incoming WhatsApp messages. A red badge shows the unread count. Click it to see the list and jump to any lead." },
        { question: "I'm not hearing the chime for new leads. Why?", answer: "The chime uses your browser's audio system. Check that your device is not on silent/mute and that your browser has permission to play audio. Refreshing the page will re-initialize the notification listener." },
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
            { step: 1, title: "Click 'New Lead'", description: "Go to the Leads page and click the 'New Lead' button in the top right corner.", hint: "You can also use Cmd+K and type 'new lead' to open the form from anywhere in the app." },
            { step: 2, title: "Fill in contact details", description: "Enter the lead's first name, last name, email, and mobile number — both email and mobile are mandatory. Add company name and any other details.", hint: "Double-check the email and mobile number — these are used for automated SMS and email communications." },
            { step: 3, title: "Set workspace requirements", description: "Select the workspace type (dedicated desk, private office, etc.), preferred location, and number of seats needed.", hint: "Setting the location here helps filter the lead in location-specific dashboard views later." },
            { step: 4, title: "Choose source and status", description: "Select how the lead found you (website, referral, cold outreach, aggregator, etc.) and set the initial status (usually 'New').", hint: "Accurate source tracking helps your team understand which channels are generating the most leads." },
            { step: 5, title: "Save", description: "Click Save to create the lead. You will be redirected to the lead detail page with all tabs ready.", hint: "The detail page shows 5 tabs: Overview, Activities, Tasks, Proposals, and Contracts — start logging an activity right away!" },
          ],
        },
        {
          title: "Progressing a Lead Through Stages",
          steps: [
            { step: 1, title: "Open the lead", description: "Click on a lead from the list to open their detail page.", hint: "The leads list is sorted by follow-up urgency — overdue follow-ups appear first so you always start with the most urgent." },
            { step: 2, title: "Update the status", description: "Use the status dropdown at the top to move the lead: New → Qualified → Proposal Sent → Negotiation → Won or Lost.", hint: "Some status changes trigger automatic actions — for example, sending a proposal automatically moves the status to 'Proposal Sent'." },
            { step: 3, title: "Log activities", description: "Record calls, meetings, emails, and notes in the Activities tab to maintain a full history of interactions.", hint: "Detailed activity notes are invaluable when handing off a lead to a colleague — they can read the history and pick up seamlessly." },
            { step: 4, title: "Create a proposal", description: "When the lead is qualified, go to the Proposals tab and create a proposal. The lead's details are pre-filled.", hint: "A Razorpay payment link can be attached to the proposal so the client can pay the security deposit directly." },
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
            { step: 1, title: "Navigate to the lead", description: "Open the lead's detail page and click the 'Proposals' tab.", hint: "You can also go to Proposals from the sidebar to see all proposals across all leads." },
            { step: 2, title: "Click 'Create Proposal'", description: "Click 'Create Proposal'. The lead's name, company, and contact details are pre-filled for you.", hint: "Check the pre-filled details are correct before adding pricing — a mismatch in the client name will show on the PDF." },
            { step: 3, title: "Configure the proposal", description: "Add a title, set the workspace type, pricing, duration, and any special terms. You can also add a UPI QR code for easy payment reference.", hint: "Use the Notes field for any special conditions or custom terms you've negotiated — they'll appear on the proposal PDF." },
            { step: 4, title: "Generate a Razorpay payment link", description: "In the proposal form, you can generate a dedicated Razorpay payment link for the security deposit. The client receives a direct link to pay online.", hint: "A dedicated payment link per proposal ensures payment tracking is linked to the right deal — no confusion about which deposit payment is for which client." },
            { step: 5, title: "Save as draft", description: "Save the proposal. It starts in 'Draft' status — nothing is sent yet.", hint: "Review the PDF preview while in draft to catch any formatting issues before emailing." },
            { step: 6, title: "Email to the client", description: "Click 'Email'. A dialog opens with the lead's primary email pre-filled. You can type more email addresses and press Enter to add them. Then click 'Send'. The PDF is attached automatically.", hint: "Add your manager or colleague's email as an extra recipient if you want them to see the proposal too." },
            { step: 7, title: "Optionally also send via WhatsApp (New ✨)", description: "If the lead has a phone number on file, you will see a green 'Also send PDF via WhatsApp' checkbox in the email dialog. Tick it before clicking Send and the proposal PDF is also delivered to the lead's WhatsApp — in addition to email.", hint: "This WhatsApp checkbox is OFF by default — you choose when to use it. WhatsApp delivery is especially useful for leads who check WhatsApp more often than email." },
          ],
        },
        {
          title: "Rejecting a Proposal",
          steps: [
            { step: 1, title: "Open the proposal", description: "Navigate to the proposal you need to mark as rejected.", hint: "You can find it from the lead's Proposals tab or from the Proposals page in the sidebar." },
            { step: 2, title: "Click 'Reject'", description: "Select the Reject action. A dialog will open asking for a rejection reason.", hint: "The rejection reason is mandatory — it's stored so the team can learn from lost deals." },
            { step: 3, title: "Enter the reason", description: "Type why the client declined (e.g., 'Price too high', 'Chose competitor XYZ', 'Requirement changed to smaller space').", hint: "Be specific — vague reasons like 'not interested' aren't helpful for future analysis. Note the real objection." },
            { step: 4, title: "Confirm", description: "Save. The proposal moves to 'Rejected' status with the reason stored. The lead's status may also be updated.", hint: "After rejecting, consider logging a note on the lead with next steps — can you re-engage at a later date?" },
          ],
        },
        {
          title: "Attaching KYC Documents to a Proposal",
          steps: [
            { step: 1, title: "Open the proposal", description: "Navigate to the relevant proposal from the lead's Proposals tab.", hint: "Collect KYC documents early — before the agreement stage — to avoid delays in onboarding." },
            { step: 2, title: "Scroll to the Documents section", description: "Scroll down within the proposal detail page to find the KYC/Documents section.", hint: "You'll see an upload area with a dashed border — it supports drag and drop." },
            { step: 3, title: "Upload files", description: "Upload ID proof, address proof, GST certificate, or other KYC documents. PDF and image formats (JPG, PNG) are supported.", hint: "Files are stored securely and are visible to all team members with access to the proposal." },
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
        "If the lead has a phone number, you can tick the WhatsApp checkbox in the email dialog to send the proposal PDF to their WhatsApp as well.",
      ],
      faqs: [
        { question: "Can I edit a proposal after sending it?", answer: "Yes, you can edit the proposal content. However, the previously sent PDF will not update in the recipient's inbox. You would need to re-send the updated version." },
        { question: "What email address are proposals sent from?", answer: "All emails are sent from contact@theworkvilla.com via Google Workspace. Recipients can reply directly to this address." },
        { question: "Can I send a proposal to multiple people?", answer: "Yes. In the email dialog, type each additional email address and press Enter to add them. All recipients will receive the same email with the proposal PDF attached." },
        { question: "Is a rejection reason mandatory?", answer: "Yes. When rejecting a proposal, you must enter a reason. This ensures there is always an explanation on record for why an opportunity was lost." },
        { question: "How does the WhatsApp send option work?", answer: "When you open the email dialog, a green 'Also send PDF via WhatsApp' checkbox appears if the lead has a phone number saved. Tick it before clicking Send — the proposal PDF is sent to their WhatsApp number in addition to email. It is not ticked by default, so WhatsApp is only used when you deliberately choose it." },
      ],
      roles: null,
    },

    /* ============================================================== */
    /*  8. Invoices                                                    */
    /* ============================================================== */
    {
      id: "invoices",
      title: "Invoices (Proforma)",
      icon: Receipt,
      overview:
        "The Invoices module lets you generate proforma invoices for clients — used for quoting before a deal is finalised. Each invoice is auto-numbered, linked to a lead, and can be emailed as a PDF. Track invoice status from Draft through to Paid or Overdue.",
      workflows: [
        {
          title: "Creating and Sending a Proforma Invoice",
          steps: [
            { step: 1, title: "Go to Invoices", description: "Navigate to the Invoices page from the sidebar under Finance." },
            { step: 2, title: "Click 'New Invoice'", description: "Click the create button to start a new proforma invoice." },
            { step: 3, title: "Fill in details", description: "Select the lead, add line items with descriptions and amounts, and set the due date." },
            { step: 4, title: "Save the invoice", description: "Save to create the invoice as a Draft. You can preview the PDF before sending." },
            { step: 5, title: "Email to the client", description: "Click 'Email' to open the send dialog. The lead's email is pre-filled. Click Send to deliver the PDF.", hint: "The invoice PDF automatically includes your company bank details so the client knows how to pay." },
            { step: 6, title: "Optionally also send via WhatsApp (New ✨)", description: "If the lead has a phone number, a green 'Also send PDF via WhatsApp' checkbox appears in the email dialog. Tick it to send the invoice to their WhatsApp in addition to email.", hint: "The WhatsApp checkbox is OFF by default. Only tick it when you want to reach the client through WhatsApp as well." },
          ],
        },
      ],
      tips: [
        "Overdue invoices are highlighted in red so they stand out in the list.",
        "Use the status filter to quickly find all unpaid or overdue invoices.",
        "The invoice PDF includes your company bank details for payment.",
        "If the lead has a phone number, use the WhatsApp checkbox in the email dialog to send the invoice to their WhatsApp as well.",
      ],
      faqs: [
        { question: "What is the difference between a Proforma Invoice and a GST Invoice?", answer: "A Proforma Invoice (this module) is a preliminary quote or request for payment — used before the service starts or when you need a document for the client before a formal contract. A GST Invoice in the Accounting module is the official tax invoice issued after billing, used for GST compliance and tax filing." },
        { question: "Can I mark an invoice as paid?", answer: "Yes. Open the invoice and change its status to 'Paid' when payment is confirmed." },
        { question: "How does the WhatsApp send option work on invoices?", answer: "In the email send dialog, a green 'Also send PDF via WhatsApp' checkbox appears if the lead has a phone number. Tick it before clicking Send and the invoice PDF is also sent to their WhatsApp. This is opt-in — unticked by default." },
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
            { step: 1, title: "Go to Contracts", description: "Navigate to the Contracts page from the sidebar and click 'New Contract'.", hint: "You can also create a contract from a lead's detail page — this pre-fills the lead's details automatically." },
            { step: 2, title: "Link to a lead", description: "Select the lead this contract is for. Their name, company, and contact details will be pre-filled.", hint: "If the lead doesn't appear in the dropdown, make sure they are marked as 'Qualified' or further in the pipeline." },
            { step: 3, title: "Set terms", description: "Configure the title, start date, tenure (months), billing cycle (monthly/quarterly/annual), and total monthly fee.", hint: "Double-check the billing cycle — a monthly vs quarterly setting affects when GST invoices are generated in Accounting." },
            { step: 4, title: "Set the security deposit", description: "Enter the security deposit amount. You can generate a dedicated Razorpay payment link so the client can pay the deposit online before signing.", hint: "The contract is gated — certain status transitions require the security deposit to be confirmed as paid first." },
            { step: 5, title: "Save as draft", description: "Save the contract. It starts in 'Draft' status — nothing is active yet.", hint: "Draft contracts appear in the Contracts list with a grey badge. You can edit them freely before activating." },
            { step: 6, title: "Send to client", description: "Click 'Send to Client' to automatically email the signed agreement PDF to the client's email address.", hint: "The PDF is generated and attached automatically — no need to download and attach it manually." },
            { step: 7, title: "Activate", description: "Once signed and the deposit is confirmed, update the status to 'Active'. This is now a live membership.", hint: "Active contracts feed into the Accounting module automatically — monthly GST invoices and billing statements are generated from here." },
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
        "The Accounting module provides a monthly financial overview. Select a month and see all contract revenue, walk-in collections, cash handovers, GST invoices, and petty cash in one place. An orange 'Action Required' banner at the top aggregates all pending items so nothing is missed. Auto-billing generates GST invoice PDFs, Razorpay payment links, and sends them to clients automatically each billing cycle. GST invoices can also be manually sent via email — and optionally via WhatsApp as well. Periods can be locked after reconciliation.",
      workflows: [
        {
          title: "Reviewing a Monthly Period",
          steps: [
            { step: 1, title: "Select the month", description: "Use the month picker at the top of the page to select the year and month you want to review.", hint: "The most recently used month is remembered — you won't need to re-select it each time you return." },
            { step: 2, title: "Check the Action Required banner", description: "The orange banner at the top lists all pending action items grouped by type. Click any item to jump directly to the relevant tab.", hint: "Start here every time — it's your todo list for the month. The banner disappears when everything is cleared." },
            { step: 3, title: "Review Contracts tab", description: "See all active contract-based revenue, facility usage charges, and payment status for the month.", hint: "The summary cards at the top show totals: Billable, Collected, Outstanding, and Aging (30/60/90-day overdue)." },
            { step: 4, title: "Check Walk-in Collections", description: "Switch to the Walk-in tab to see one-time payments from walk-in customers.", hint: "Walk-in collections are added by front desk staff when a customer pays for a day pass or meeting room." },
            { step: 5, title: "Review Cash Handovers", description: "Check the Cash Handovers tab for pending and completed cash transfers from the front desk to accounts.", hint: "Pending handovers show in the Action Required banner — action them quickly to keep the cash reconciliation clean." },
            { step: 6, title: "Manage GST Invoices", description: "The GST Invoices tab shows all tax invoices for the period. Auto-billed invoices are generated automatically with a PDF and Razorpay payment link. For any invoice, click the email icon (✉️) to send or re-send it manually.", hint: "In the email dialog, tick the green 'Also send via WhatsApp' checkbox to also deliver the invoice PDF to the client's WhatsApp. This is opt-in and off by default." },
            { step: 7, title: "Lock the period", description: "Once reconciliation is complete, click 'Lock Period' to prevent further changes. Only Admins and Managers can lock.", hint: "Locked periods show a blue bar at the top with the locker's name and timestamp — a clear audit trail." },
          ],
        },
        {
          title: "Auto-Billing (GST Invoice + Razorpay + Email)",
          steps: [
            { step: 1, title: "Auto-billing runs automatically", description: "For active contracts with billing cycle due, the system auto-generates a GST invoice PDF for the period.", hint: "Auto-billing runs based on each contract's billing cycle date. No manual trigger is needed." },
            { step: 2, title: "Razorpay payment link is created", description: "A Razorpay payment link is automatically generated and embedded in the invoice email so the client can pay online.", hint: "The payment link is unique per invoice — when the client pays, the invoice status updates automatically." },
            { step: 3, title: "Email is sent to client", description: "The GST invoice PDF and payment link are emailed to the client's registered email address automatically.", hint: "You can find the sent email in the Activities section of the linked contract." },
            { step: 4, title: "Check invoice status", description: "In the GST Invoices tab, each auto-billed invoice shows whether the email was sent and whether payment has been received.", hint: "If a client says they didn't receive the invoice, check the email status here and resend from the invoice detail page." },
          ],
        },
      ],
      tips: [
        "The 'Action Required' banner is your daily accounting checklist — review it at the start of each day.",
        "Auto-billing handles GST invoice generation, Razorpay payment links, and client emails automatically — no manual work needed.",
        "Summary cards show: Billable, Collected, Outstanding, Cash Pending, and Cash Handed Over totals at a glance.",
        "The aging analysis shows current vs 30/60/90-day overdue amounts — prioritize the oldest outstanding amounts.",
        "Locked periods display a status bar showing who locked them and when — great for audit accountability.",
        "The Petty Cash tab inside Accounting shows all books, approvals, and pending fund issuances.",
        "When manually sending a GST invoice by email, tick the 'Also send via WhatsApp' checkbox to also deliver the PDF to the client's WhatsApp.",
      ],
      faqs: [
        { question: "Can I unlock a locked period?", answer: "Yes. An Admin or Manager can unlock a period to make corrections, then lock it again. The unlock action is logged in the audit trail." },
        { question: "What does the 'Carried Forward' amount mean?", answer: "It represents outstanding balances from previous periods that are still unpaid. These carry into the current month's outstanding total." },
        { question: "What is the Action Required banner?", answer: "An orange banner at the top of the Accounting page aggregating all pending items: outstanding contract payments, pending cash handovers, GST invoices to send, petty cash funds to issue, and expenses awaiting admin approval. Click any item to jump to the relevant tab. It hides when there are no pending items." },
        { question: "How does auto-billing work?", answer: "When a contract's billing cycle is due, the system automatically generates a GST invoice PDF, creates a Razorpay payment link, and emails both to the client. You can monitor invoice status and payment from the GST Invoices tab." },
        { question: "Can I send a GST invoice via WhatsApp?", answer: "Yes. Click the email icon (✉️) on any GST invoice row to open the send dialog. Tick the green 'Also send via WhatsApp' checkbox at the bottom of the dialog, then click Send Invoice. The PDF will be delivered to the client's WhatsApp in addition to email. This is opt-in and off by default." },
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
        { question: "What are the available roles?", answer: "Admin: Full access including user management and deletion. Manager: Full data access across all leads and records. Sales Rep: Only sees own leads and assigned tasks. Floor Incharge: Focus on space and booking operations." },
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
      title: "Email, SMS & WhatsApp",
      icon: Mail,
      overview:
        "The CRM communicates with customers through three channels: Email (from contact@theworkvilla.com), DLT-compliant SMS via MSG91, and WhatsApp (via MSG91 WhatsApp Business). Emails are sent for proposals, contracts, GST invoices, booking confirmations, and payment reminders — all logged automatically as activities. SMS is sent automatically at key touchpoints (booking confirmation, payment receipt, etc.) using TRAI-registered templates. WhatsApp is opt-in: when sending a proposal, proforma invoice, or GST invoice, you can tick a checkbox to also deliver the PDF to the customer's WhatsApp. A daily business digest is sent at 8:30 PM IST to keep the management team informed.",
      workflows: [
        {
          title: "Sending an Email from the CRM",
          steps: [
            { step: 1, title: "Open the document", description: "Navigate to the proposal, contract, invoice, or booking you want to email.", hint: "Look for the 'Email' or 'Send' button — it's available on proposals, contracts, GST invoices, booking receipts, and vouchers." },
            { step: 2, title: "Click 'Email'", description: "Click the Email button. A dialog opens with the lead's email address pre-filled.", hint: "Double-check the email address before sending — it's pulled from the lead's profile and may need updating." },
            { step: 3, title: "Add extra recipients", description: "The lead's email is the default. Type additional email addresses and press Enter to add them as CCs.", hint: "You can add your own email as a BCC to keep a copy in your inbox for reference." },
            { step: 4, title: "Send", description: "Click Send. The PDF is generated and attached automatically. The send action is logged as an activity.", hint: "After sending, check the Activities tab on the lead's page to confirm delivery and see all recipients." },
          ],
        },
        {
          title: "Sending Documents via WhatsApp (New ✨)",
          steps: [
            { step: 1, title: "Open the email send dialog", description: "When you click 'Email' on a Proposal, Proforma Invoice, or GST Invoice, a dialog opens with the recipient email field.", hint: "The WhatsApp option only appears if the lead has a phone number saved in their profile." },
            { step: 2, title: "Look for the WhatsApp checkbox", description: "At the bottom of the dialog, you will see a green WhatsApp section with a checkbox: 'Also send PDF via WhatsApp (phone number)'. The phone number is shown in grey next to it.", hint: "This checkbox is OFF by default. WhatsApp will NOT be used unless you tick it." },
            { step: 3, title: "Tick the checkbox if desired", description: "Tick the checkbox if you want to send the document to the customer's WhatsApp as well. Leave it unticked to send by email only.", hint: "Use WhatsApp for customers who are more responsive on WhatsApp than email — especially for payment reminders and GST invoice delivery." },
            { step: 4, title: "Click Send", description: "Click the Send button. The document PDF is emailed as normal. If you ticked WhatsApp, it is also delivered to the customer's WhatsApp as a document message.", hint: "WhatsApp delivery happens in the background — the dialog closes immediately even before WhatsApp delivery completes." },
          ],
        },
        {
          title: "Daily Business Digest",
          steps: [
            { step: 1, title: "Automatic delivery at 8:30 PM IST", description: "Every evening at 8:30 PM, the system sends a business digest email to the management team summarizing the day's activity.", hint: "No setup needed — Admins and Managers receive the digest automatically." },
            { step: 2, title: "What's in the digest", description: "The digest includes: new leads added, bookings made, invoices sent, payments received, pending follow-ups, and a summary of pending vendor bills.", hint: "The vendor bills summary in the digest shows outstanding bills detail so accounts can plan the next day's payments." },
            { step: 3, title: "Use the digest as a daily review", description: "Review the digest each evening to catch anything that was missed during the day — overdue follow-ups, unpaid invoices, or flagged items.", hint: "The digest is a read-only summary — click through to the CRM for any action items it flags." },
          ],
        },
      ],
      tips: [
        "All emails include a Reply-To address of contact@theworkvilla.com — replies from clients land in the Google Workspace inbox.",
        "The daily digest at 8:30 PM IST is a great way for managers to review the day's activity without logging into the CRM.",
        "SMS messages are sent automatically for bookings, payment confirmations, and key events — no manual action needed.",
        "Check the Activities tab on any lead to see every email sent to that client, including the recipient list.",
        "If a client says they didn't receive an email, first ask them to check spam, then verify the email address in their lead profile.",
        "WhatsApp delivery is opt-in — always a checkbox you tick. It is never sent automatically without your choice.",
        "For customers who prefer WhatsApp, use the WhatsApp checkbox when sending GST invoices and proposals for faster acknowledgement.",
      ],
      faqs: [
        { question: "What email address do emails come from?", answer: "All CRM emails are sent from 'The WorkVilla <contact@theworkvilla.com>' via Google Workspace SMTP." },
        { question: "Can recipients reply to CRM emails?", answer: "Yes. The reply-to address is set to contact@theworkvilla.com. Replies go to the Google Workspace inbox." },
        { question: "An email was not received. What should I check?", answer: "Ask the recipient to check their spam/junk folder. Verify the email address is correct in the lead profile. Check the lead's activity timeline to confirm the send was logged." },
        { question: "What is the daily digest?", answer: "An automated summary email sent at 8:30 PM IST to Admins and Managers. It covers new leads, bookings, payments, pending follow-ups, and outstanding vendor bills — a one-page snapshot of the day's business." },
        { question: "What is DLT-compliant SMS?", answer: "DLT (Distributed Ledger Technology) is TRAI's mandatory framework for commercial SMS in India. The CRM's templates are pre-registered with the regulator via MSG91 for guaranteed deliverability. These cover key customer-facing events like booking confirmation and payment receipt." },
        { question: "How do I send a document via WhatsApp?", answer: "When you click 'Email' on a Proposal, Proforma Invoice, or GST Invoice, the send dialog has a green 'Also send via WhatsApp' checkbox at the bottom (only visible if the lead has a phone number). Tick it before clicking Send. The PDF will be delivered to the customer's WhatsApp business number in addition to email." },
        { question: "Is WhatsApp sent automatically?", answer: "No. WhatsApp sending is always opt-in. The checkbox is OFF by default. WhatsApp is only used when you deliberately tick the checkbox in the email dialog." },
        { question: "Does the customer need to save our number to receive WhatsApp messages?", answer: "No. WhatsApp Business API (which we use via MSG91) can deliver messages even if the customer hasn't saved the number. However, if the customer has not interacted with our number before, the message arrives as a business message notification." },
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
            { step: 1, title: "Go to Support Tickets", description: "Navigate to Support Tickets from the sidebar. You'll see the ticket list with status filters at the top.", hint: "Any team member at any role can create a ticket — encourage everyone to report issues here instead of verbally." },
            { step: 2, title: "Click 'New Ticket'", description: "Click the create button to open the new ticket form.", hint: "The form is simple — just a subject, type, priority, and description. You can submit in under a minute." },
            { step: 3, title: "Fill in details", description: "Enter a subject (short and clear), select the ticket type (Maintenance, Customer Issue, IT, etc.), and set priority (Low, Medium, High, Urgent).", hint: "Use 'Urgent' only for issues actively impacting customers or operations — it puts the ticket at the top of the queue." },
            { step: 4, title: "Describe the issue", description: "Add a detailed description: what happened, when, which location, and what impact it's having.", hint: "More detail = faster resolution. Include room numbers, equipment names, or error messages if relevant." },
            { step: 5, title: "Assign (optional)", description: "Optionally assign to a specific team member. If left unassigned, it appears in the general triage queue for Managers.", hint: "If you know who should handle it, assign it directly to reduce the triage step." },
            { step: 6, title: "Submit", description: "Save the ticket. It appears in the list with status 'Open' and an auto-assigned number (TWV-T-XXXX).", hint: "Note the ticket number — it's your reference for any follow-up conversations about this issue." },
          ],
        },
        {
          title: "Managing and Resolving Tickets",
          steps: [
            { step: 1, title: "Review the ticket list", description: "Filter tickets by status (Open, In Progress, Resolved, Closed), priority, or type using the filter buttons at the top.", hint: "Sort by priority to see Urgent tickets first — these need the fastest response." },
            { step: 2, title: "Assign and start working", description: "Click a ticket to open it. Update the assignee and change the status to 'In Progress' when work begins.", hint: "Changing to 'In Progress' signals to the reporter that their issue is being handled — do this as soon as you pick it up." },
            { step: 3, title: "Add progress notes", description: "Log updates, findings, and communications in the notes section as you work on the issue.", hint: "Notes are visible to the reporter — they'll see your progress without needing to ask for an update." },
            { step: 4, title: "Resolve or close", description: "Set status to 'Resolved' when the fix is done. The reporter will see this and can reopen if needed, or it moves to 'Closed'.", hint: "Always add a closing note explaining how the issue was resolved — this becomes a knowledge base for similar issues in future." },
          ],
        },
        {
          title: "Tracking Your Own Tickets (My Tickets)",
          steps: [
            { step: 1, title: "Switch to 'My Tickets' tab", description: "On the Support Tickets page, click the 'My Tickets' tab to see only the tickets you personally created.", hint: "This tab is available to all roles — great for frontline staff to track issues they've reported." },
            { step: 2, title: "Monitor status", description: "You can see each ticket's status update in real time — from Open through In Progress to Resolved.", hint: "No need to ask your manager 'has that issue been fixed?' — just check My Tickets for the latest status." },
            { step: 3, title: "Reopen if the issue persists", description: "If a ticket was marked Resolved or Closed but the problem is still there, click 'Reopen'. The ticket goes back to Open and the assignee is notified.", hint: "As the ticket creator, only you (or an Admin) can reopen it — this ensures the resolution is confirmed by the person who raised the issue." },
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
        "The Procurement module manages the full purchasing lifecycle — from vendor management and item catalogues through material requests, purchase orders (goods and services), delivery receipts, vendor bills, and bill approvals. All team members (including Sales Reps) can submit material requests. Floor Incharges and FMS can create POs and manage the item catalogue. Managers and Admins approve everything. Service POs support recurring billing cycles and per-cycle invoicing.",
      workflows: [
        {
          title: "Adding a Vendor",
          steps: [
            { step: 1, title: "Go to Procurement → Vendors", description: "Navigate to Procurement from the sidebar and select the Vendors tab.", hint: "Floor Incharges and FMS can also add vendors — this role was recently expanded." },
            { step: 2, title: "Click 'New Vendor'", description: "Click the create button and fill in the vendor name, contact details, category, and payment terms.", hint: "Adding GST number and bank details to the vendor profile saves time when creating bills later." },
            { step: 3, title: "Save", description: "The vendor is now available when creating purchase orders and bills.", hint: "You can also manage the Item Catalogue from Procurement — add standard items here to speed up PO creation." },
          ],
        },
        {
          title: "Submitting a Material Request",
          steps: [
            { step: 1, title: "Go to Material Requests", description: "Navigate to Procurement → Material Requests from the sidebar.", hint: "Any team member (all roles) can submit a purchase request — even Sales Reps!" },
            { step: 2, title: "Click 'New Request'", description: "Describe the items needed, quantity, estimated unit cost, and the reason for the purchase.", hint: "Be specific in your description — vague requests are harder to approve and may be sent back to you." },
            { step: 3, title: "Submit for approval", description: "Submit the request. A Manager or Admin reviews and approves or rejects it. You'll see the status update on the request.", hint: "You can track the status of your submitted requests in the Material Requests list — filter by 'My Requests'." },
            { step: 4, title: "Request approved", description: "Once approved, a Purchase Order can be raised against the request by a Manager, Admin, or Floor Incharge.", hint: "You'll see the request status change to 'Approved' — from here, a PO can be raised to place the order with a vendor." },
          ],
        },
        {
          title: "Raising a Goods Purchase Order",
          steps: [
            { step: 1, title: "Go to Purchase Orders", description: "Navigate to Procurement → Purchase Orders.", hint: "Managers, Admins, Floor Incharges, and FMS can create POs. Sales Reps can only submit requests." },
            { step: 2, title: "Create from an approved request", description: "Click 'New PO', select type 'Goods'. Link to an approved purchase request — the items are pre-filled from the request.", hint: "Linking to a request ensures full traceability from the original need to the final payment." },
            { step: 3, title: "Select vendor and confirm line items", description: "Choose the vendor from your vendor list. Review item names, quantities, and unit prices. You can adjust prices within the approved estimated range.", hint: "Use catalogue items where possible — they have pre-set names and unit types so there are no inconsistencies." },
            { step: 4, title: "Record delivery receipt", description: "When goods arrive, click 'Record Delivery' on the PO. Enter the received quantities for each line item.", hint: "Record partial deliveries too — you don't need to wait for the full order. Partial receipts unlock partial billing." },
            { step: 5, title: "Raise vendor bill", description: "After at least one delivery receipt, click 'Create Bill'. The bill amount is automatically capped at the proportionate value of goods actually received.", hint: "If the vendor's invoice exceeds the received value, a red inline error will appear and the system will block submission." },
          ],
        },
        {
          title: "Raising a Service Purchase Order",
          steps: [
            { step: 1, title: "Create a Service PO", description: "Click 'New PO' and select type 'Service'. Enter the service description, cost per cycle, billing cycle (monthly/quarterly/yearly), and number of cycles.", hint: "Use Service POs for housekeeping, security, internet, or any recurring contracted service." },
            { step: 2, title: "Track billing cycles", description: "Each billing cycle appears as a row on the PO detail page. Mark cycles as completed as the service is delivered.", hint: "The cycle tracker gives you a clear view of which months have been invoiced and which are pending." },
            { step: 3, title: "Upload service reports", description: "Attach service completion reports, attendance sheets, or delivery proof for each billing cycle.", hint: "Keep proof of service delivery — this is important for bill approval and audit purposes." },
            { step: 4, title: "Raise per-cycle invoices", description: "Create a vendor bill for each completed billing cycle. The bill amount is capped at the cost per cycle.", hint: "If a vendor sends one consolidated invoice for multiple cycles, create separate bills per cycle to keep the records clean." },
          ],
        },
        {
          title: "Recording a Vendor Bill and Getting it Approved",
          steps: [
            { step: 1, title: "Go to Vendor Bills", description: "Navigate to Procurement → Vendor Bills.", hint: "Bills can also be created directly from the PO detail page using the 'Create Bill' button — this is faster." },
            { step: 2, title: "Link to a PO and upload invoice", description: "Select the linked Purchase Order, upload the vendor's physical invoice file (mandatory for PO-linked bills), and enter the invoice number, date, and amount.", hint: "The invoice file is required — always upload the original vendor invoice document to maintain records." },
            { step: 3, title: "Check the amount", description: "For goods POs with a delivery shortfall, an inline error appears in red if your amount exceeds the received value. Correct it before submitting.", hint: "The field turns red and the Save button is disabled until the amount is within the allowed ceiling — so you can't accidentally overpay." },
            { step: 4, title: "Submit for approval", description: "Save the bill. It enters the approval queue for a Manager or Admin to review.", hint: "Bills with approval pending are shown in the Vendor Bills list with an 'Awaiting Approval' badge." },
            { step: 5, title: "Approved → Record payment", description: "Once approved, click 'Record Payment'. Select the payment mode (cash, UPI, bank transfer), enter the reference number, and confirm.", hint: "Add the UTR number or transaction ID in the reference field — this creates a clean audit trail for every payment." },
          ],
        },
      ],
      tips: [
        "All team members can submit material requests — encourage everyone to use the system instead of verbal requests.",
        "Floor Incharges can create POs and manage the item catalogue — they don't need to wait for a Manager.",
        "A vendor bill for a goods PO is blocked until at least one delivery receipt is recorded — always log receipt of goods first.",
        "If a delivery shortfall exists (received qty < ordered qty), the bill is capped proportionately — an inline red error prevents overpayment.",
        "Service POs are ideal for recurring contracts — one PO covers the full year with per-cycle invoicing.",
        "Filter vendor bills by status to see what's pending payment at a glance.",
        "Use the Item Catalogue for standard items to ensure consistent naming across all POs.",
      ],
      faqs: [
        { question: "Who can submit material requests?", answer: "All team members across all roles can submit material requests. Sales Reps, Floor Incharges, FMS, Managers, and Admins can all create requests. Only Managers and Admins can approve them." },
        { question: "Who can create Purchase Orders?", answer: "Managers, Admins, Floor Incharges, and FMS can create Purchase Orders. Sales Reps can submit requests but cannot raise POs." },
        { question: "Who can manage the Item Catalogue?", answer: "Admins, Managers, and Floor Incharges can add and edit items in the catalogue." },
        { question: "Can I create a PO without a purchase request?", answer: "Yes. For routine or emergency purchases, you can create a Purchase Order directly without linking to a request." },
        { question: "What is the Item Catalogue?", answer: "A reusable list of standard items (cleaning supplies, stationery, furniture, etc.) with standard descriptions and prices. Using catalogue items speeds up PO and bill creation and ensures consistent item naming." },
        { question: "Why can't I create a vendor bill for my goods PO?", answer: "A vendor bill requires at least one delivery receipt to be recorded first. Record the goods received (even a partial delivery) before creating the bill." },
        { question: "Why is the bill amount limited?", answer: "If fewer goods were delivered than ordered, the bill is capped at the proportionate received value. For example, if 60% of goods were delivered, the bill cannot exceed 60% of the PO value. This protects against overpayment for undelivered goods." },
        { question: "What is a Service PO?", answer: "A Service PO covers recurring or contracted services (housekeeping, security, internet, etc.). It's structured around billing cycles so you raise a separate invoice for each cycle as the service is delivered." },
      ],
      roles: ["admin", "manager", "floor_manager"],
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
            { step: 1, title: "Go to Petty Cash", description: "Navigate to Petty Cash from the sidebar under Finance.", hint: "Your personal petty cash book is auto-created the first time you open this page — no setup needed." },
            { step: 2, title: "View your book", description: "The 'My Book' tab shows your current balance, recent expenses, and pending items.", hint: "Your balance shows at the top of your book. If it's low, request more funds before submitting expenses." },
            { step: 3, title: "Click 'Request Funds'", description: "Click 'Request Funds', enter the amount needed and the purpose, then submit.", hint: "Be specific about what the funds are for — this helps the approver understand the business need quickly." },
            { step: 4, title: "Funds are approved and issued", description: "Once approved by a Manager, the request appears in Accounting for the accounts team to issue cash/transfer. Your balance updates when funds are issued.", hint: "You can track the request status in your book — it moves from Pending → Approved → Issued." },
          ],
        },
        {
          title: "Logging an Expense",
          steps: [
            { step: 1, title: "Open your book", description: "Go to Petty Cash → My Book. Your current balance is shown at the top.", hint: "Make sure you have sufficient balance before logging an expense — you can't log more than your available balance." },
            { step: 2, title: "Click 'Add Expense'", description: "Enter the date, amount, category (stationery, travel, maintenance, etc.), and a clear description.", hint: "Choose the most accurate category — this feeds the 'Spend by Category' analytics chart visible to managers." },
            { step: 3, title: "Submit the expense", description: "Click Submit. Expenses under ₹5,000 go to your Manager for approval. ₹5,000 and above require both Manager and Admin approval.", hint: "Keep your receipt — the approver may ask for it, especially for larger amounts." },
            { step: 4, title: "Approved — balance deducted", description: "Once fully approved, the expense amount is deducted from your book balance automatically.", hint: "You'll see the expense change from 'Pending' to 'Approved' in your book. The balance updates instantly." },
          ],
        },
        {
          title: "Editing and Resubmitting a Rejected Expense",
          steps: [
            { step: 1, title: "Find the rejected entry", description: "In your My Book view, rejected expenses are highlighted with a red indicator and the rejection reason shown below.", hint: "Read the rejection reason carefully — it tells you exactly what to fix before resubmitting." },
            { step: 2, title: "Click 'Edit & Resubmit'", description: "Click the 'Edit & Resubmit' button on the rejected entry. The form opens pre-filled with the original details.", hint: "You can change the date, amount, category, or description — all fields are editable." },
            { step: 3, title: "Make corrections and resubmit", description: "Update the details based on the rejection reason, then click Submit. The expense re-enters the approval workflow from the beginning.", hint: "If you're unsure why it was rejected, message the approver directly before resubmitting to avoid another rejection." },
          ],
        },
        {
          title: "Approving Expenses and Requests (Manager/Admin)",
          steps: [
            { step: 1, title: "Go to the Approvals tab", description: "Navigate to Petty Cash → Approvals. This tab is only visible to Managers and Admins.", hint: "The number badge on the Approvals tab shows how many items are waiting for your action." },
            { step: 2, title: "Review fund requests", description: "The Fund Requests section shows who is requesting funds, their current balance, and the requested amount.", hint: "Review the requester's current balance before approving — if they already have funds available, ask them to use those first." },
            { step: 3, title: "Review and approve/reject expenses", description: "The Expense Approvals section shows all pending expenses with details, category, and amount. Click Approve or Reject (with an optional note).", hint: "For rejections, always add a note explaining why — this helps the team member correct and resubmit successfully." },
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
    { question: "What happens if the internet goes down?", answer: "If you have the CRM installed as a PWA, you can still browse recently visited pages in read-only mode. Saving new records requires an active connection. Changes sync automatically when you reconnect. We recommend saving frequently." },
    { question: "Can I install the CRM as an app on my phone?", answer: "Yes! Open the CRM in Chrome (Android) or Safari (iPhone), then tap 'Add to Home Screen'. The app installs as a PWA and runs full-screen like a native app. It also supports limited offline browsing." },
    { question: "Can I undo a change?", answer: "There is no undo button. However, Admins can review the Audit Logs to see what changed and manually reverse it if needed." },
    { question: "Why can I not see certain modules in the sidebar?", answer: "Your access is determined by your role. Sales Reps have limited access. Managers and Admins see additional modules. Ask your Admin to check your role if you believe access is incorrect." },
    { question: "How do I contact support?", answer: "Email contact@theworkvilla.com or call +91 97910 97900 during business hours." },
    { question: "Can I send documents to customers on WhatsApp?", answer: "Yes! When emailing a Proposal, Proforma Invoice, or GST Invoice, the send dialog has a green 'Also send via WhatsApp' checkbox. Tick it to also deliver the PDF to the customer's WhatsApp. This requires the lead to have a phone number saved, and is always opt-in (off by default)." },
    { question: "How do I get notified about new leads in real time?", answer: "The 🔔 bell icon in the top navigation bar lights up with a red badge whenever a new lead arrives from Google Ads, Meta Ads, or the Walk-in form. A chime also plays. Click the bell to see the new enquiries and jump to the lead directly." },
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
    { feature: "Material Requests (submit)", admin: true, manager: true, sales_rep: true, floor_manager: true },
    { feature: "Procurement (view)", admin: true, manager: true, sales_rep: false, floor_manager: true },
    { feature: "Procurement (create PO/vendors/catalogue)", admin: true, manager: true, sales_rep: false, floor_manager: true },
    { feature: "Procurement (approve PRs/bills)", admin: true, manager: true, sales_rep: false, floor_manager: false },
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
