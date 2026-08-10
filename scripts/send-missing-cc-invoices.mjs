import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { Resend } from "resend";

const env = {};
const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of raw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    v = v.replace(/\\n$/, "");
    env[m[1]] = v;
  }
}
const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DRY = process.argv.includes("--dry");

const missingCc = JSON.parse(
  readFileSync(new URL("./.backfill-missing-cc.json", import.meta.url), "utf8"),
);

const smtpUser = (env.SMTP_USER || "").trim();
const smtpPass = (env.SMTP_PASS || "").trim();
const smtpHost = (env.SMTP_HOST || "smtp.gmail.com").trim();
const smtpPort = parseInt((env.SMTP_PORT || "587").trim(), 10);

let sendMail;
if (smtpUser && smtpPass) {
  const nodemailer = (await import("nodemailer")).default;
  const transporter = nodemailer.createTransport({
    host: smtpHost, port: smtpPort, secure: smtpPort === 465, requireTLS: smtpPort === 587,
    auth: { user: smtpUser, pass: smtpPass },
  });
  sendMail = async ({ to, cc, subject, html, attachments }) => {
    const info = await transporter.sendMail({
      from: `The WorkVilla <${smtpUser}>`, to: to.join(", "), cc: cc.join(", "),
      bcc: "billing@theworkvilla.com", replyTo: "billing@theworkvilla.com", subject, html, attachments,
    });
    return { id: info.messageId };
  };
} else {
  const resend = new Resend(env.RESEND_API_KEY);
  sendMail = async ({ to, cc, subject, html, attachments }) => {
    const result = await resend.emails.send({
      from: "The WorkVilla <onboarding@theworkvilla.com>", to, cc, bcc: "billing@theworkvilla.com",
      replyTo: "billing@theworkvilla.com", subject, html,
      attachments: attachments.map((a) => ({ filename: a.filename, content: a.content.toString("base64") })),
    });
    if (result.error) throw new Error(result.error.message);
    return { id: result.data?.id };
  };
}

console.log(`${missingCc.length} statements to catch up. DRY=${DRY}\n`);

for (const item of missingCc) {
  const { data: upload } = await supa
    .from("gst_invoice_uploads")
    .select("invoice_pdf_url, tally_invoice_number, invoice_amount")
    .eq("billing_statement_id", item.id)
    .is("superseded_by", null)
    .order("uploaded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!upload) {
    console.log(`SKIP ${item.stmt}: no gst_invoice_uploads row found`);
    continue;
  }

  const { data: fileBlob, error: dlErr } = await supa.storage
    .from("crm-documents")
    .download(upload.invoice_pdf_url);
  if (dlErr || !fileBlob) {
    console.log(`SKIP ${item.stmt}: PDF download failed: ${dlErr?.message}`);
    continue;
  }
  const pdfBuffer = Buffer.from(await fileBlob.arrayBuffer());
  const filename = `${item.invoice.replace(/[^\w-]/g, "_")}.pdf`;

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <p>Dear team,</p>
      <p>We're sharing your GST tax invoice <strong>${item.invoice}</strong> (contract ${item.ref}) — you were previously not on the direct distribution for this invoice due to a delivery issue on our end, now fixed. Please find it attached.</p>
      <p>Amount: Rs. ${Math.round(Number(upload.invoice_amount)).toLocaleString("en-IN")}</p>
      <p>Regards,<br/>The WorkVilla — Accounts</p>
    </div>
  `;

  if (DRY) {
    console.log(`WOULD SEND ${item.stmt} (${item.ref}) to=${item.missing.join(", ")} cc=${item.email}`);
    continue;
  }

  try {
    const result = await sendMail({
      to: item.missing,
      cc: [item.email],
      subject: `Tax Invoice ${item.invoice} — ${item.ref} — The WorkVilla`,
      html,
      attachments: [{ filename, content: pdfBuffer, contentType: "application/pdf" }],
    });
    console.log(`SENT ${item.stmt} (${item.ref}) -> ${item.missing.join(", ")} [${result.id}]`);

    await supa.from("billing_statements").update({
      gst_invoice_sent_to: [item.sentTo, ...item.missing].join(", "),
    }).eq("id", item.id);

    await supa.from("audit_trail").insert({
      entity_type: "billing_statement",
      entity_id: item.id,
      action: "email_resent",
      performed_by: null,
      changes: {
        recipient: item.missing.join(", "),
        cc: item.email,
        invoice_number: item.invoice,
        trigger: "backfill_missing_billing_emails_cc",
      },
    });
  } catch (err) {
    console.log(`FAIL ${item.stmt}: ${err.message}`);
  }
}
