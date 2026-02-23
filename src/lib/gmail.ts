import { google, gmail_v1 } from "googleapis";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

/**
 * Create an authenticated Gmail API client using OAuth2 credentials.
 */
function getGmailClient(): gmail_v1.Gmail {
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );

  auth.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
  });

  return google.gmail({ version: "v1", auth });
}

/**
 * Set up Gmail push notifications via Pub/Sub.
 * Returns the historyId to begin watching from.
 * Must be called once on setup, and renewed every 7 days.
 */
export async function setupGmailWatch(): Promise<{
  historyId: string;
  expiration: string;
}> {
  const gmail = getGmailClient();

  const response = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName: process.env.GMAIL_PUBSUB_TOPIC,
      labelIds: ["INBOX"],
    },
  });

  return {
    historyId: response.data.historyId || "",
    expiration: response.data.expiration || "",
  };
}

/**
 * Stop Gmail push notifications.
 */
export async function stopGmailWatch(): Promise<void> {
  const gmail = getGmailClient();
  await gmail.users.stop({ userId: "me" });
}

/**
 * Get new messages since a given historyId using Gmail history API.
 * Returns an array of message IDs that were added to INBOX.
 */
export async function getNewMessages(
  historyId: string
): Promise<string[]> {
  const gmail = getGmailClient();

  const response = await gmail.users.history.list({
    userId: "me",
    startHistoryId: historyId,
    historyTypes: ["messageAdded"],
    labelId: "INBOX",
  });

  const messageIds: string[] = [];
  const history = response.data.history || [];

  for (const record of history) {
    const added = record.messagesAdded || [];
    for (const msg of added) {
      if (msg.message?.id) {
        messageIds.push(msg.message.id);
      }
    }
  }

  return messageIds;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  bodyHtml: string;
  date: string;
  hasAttachments: boolean;
  attachmentNames: string[];
  labelIds: string[];
}

/**
 * Fetch a full Gmail message by its ID.
 */
export async function getGmailMessage(
  messageId: string
): Promise<GmailMessage> {
  const gmail = getGmailClient();

  const response = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const msg = response.data;
  const headers = msg.payload?.headers || [];

  const getHeader = (name: string): string => {
    const header = headers.find(
      (h) => h.name?.toLowerCase() === name.toLowerCase()
    );
    return header?.value || "";
  };

  // Parse email addresses from header
  const parseEmails = (header: string): string[] => {
    if (!header) return [];
    return header
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
  };

  // Extract body from parts
  let body = "";
  let bodyHtml = "";
  const attachmentNames: string[] = [];

  function extractParts(parts: gmail_v1.Schema$MessagePart[] | undefined) {
    if (!parts) return;
    for (const part of parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        body += Buffer.from(part.body.data, "base64url").toString("utf-8");
      } else if (part.mimeType === "text/html" && part.body?.data) {
        bodyHtml += Buffer.from(part.body.data, "base64url").toString("utf-8");
      } else if (part.filename && part.filename.length > 0) {
        attachmentNames.push(part.filename);
      }
      if (part.parts) {
        extractParts(part.parts);
      }
    }
  }

  // Handle single-part messages
  if (msg.payload?.body?.data && msg.payload.mimeType === "text/plain") {
    body = Buffer.from(msg.payload.body.data, "base64url").toString("utf-8");
  } else if (msg.payload?.body?.data && msg.payload.mimeType === "text/html") {
    bodyHtml = Buffer.from(msg.payload.body.data, "base64url").toString("utf-8");
  }

  // Handle multi-part messages
  extractParts(msg.payload?.parts);

  return {
    id: msg.id || "",
    threadId: msg.threadId || "",
    from: getHeader("From"),
    to: parseEmails(getHeader("To")),
    cc: parseEmails(getHeader("Cc")),
    subject: getHeader("Subject"),
    body,
    bodyHtml,
    date: getHeader("Date"),
    hasAttachments: attachmentNames.length > 0,
    attachmentNames,
    labelIds: msg.labelIds || [],
  };
}

/**
 * Send a reply to an existing Gmail thread.
 */
export async function sendGmailReply(params: {
  threadId: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
}): Promise<string> {
  const gmail = getGmailClient();
  const watchEmail = process.env.GMAIL_WATCH_EMAIL || "cases@theworkvilla.com";

  const headers = [
    `From: ${watchEmail}`,
    `To: ${params.to.join(", ")}`,
    ...(params.cc && params.cc.length > 0
      ? [`Cc: ${params.cc.join(", ")}`]
      : []),
    `Subject: ${params.subject}`,
    ...(params.inReplyTo
      ? [`In-Reply-To: ${params.inReplyTo}`, `References: ${params.inReplyTo}`]
      : []),
    "Content-Type: text/html; charset=utf-8",
    "",
    params.body,
  ].join("\r\n");

  const encodedMessage = Buffer.from(headers)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: encodedMessage,
      threadId: params.threadId,
    },
  });

  return response.data.id || "";
}

/**
 * Get the latest historyId for checkpoint purposes.
 */
export async function getLatestHistoryId(): Promise<string> {
  const gmail = getGmailClient();

  const response = await gmail.users.getProfile({
    userId: "me",
  });

  return response.data.historyId || "";
}

// Re-export scopes for setup verification
export { SCOPES as GMAIL_SCOPES };
