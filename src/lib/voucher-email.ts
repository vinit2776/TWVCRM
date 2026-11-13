/**
 * The WiFi access-code email a contract member receives (one voucher per seat).
 * Pure string building so the preview in the confirmation dialog and the real
 * send are guaranteed to be the same email.
 */

/** Network name shown in the email unless the location sets its own (locations.wifi_ssid). */
export const DEFAULT_WIFI_SSID = "Workvilla Clients";
export const SUPPORT_EMAIL = "support@theworkvilla.com";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Who the email greets: the member's name, else the customer's first name, else a plain "there". */
export function greetingName(memberName?: string | null, leadFirstName?: string | null): string {
  return memberName?.trim() || leadFirstName?.trim() || "there";
}

export function wifiNetworkName(locationSsid?: string | null): string {
  return locationSsid?.trim() || DEFAULT_WIFI_SSID;
}

export interface PerSeatEmailParams {
  recipientName: string;
  voucherCode: string;
  validFrom: string;
  validUntil: string;
  /** Contract end date, already formatted — renewals are offered up to this date. */
  contractEnd: string;
  wifiSsid: string;
  seatNumber: number;
  contractNumber: string;
  senderName: string;
}

export function buildPerSeatEmailHTML(params: PerSeatEmailParams): string {
  const { voucherCode, validFrom, validUntil, contractEnd, seatNumber, contractNumber } = params;
  const recipientName = escapeHtml(params.recipientName);
  const wifiSsid = escapeHtml(params.wifiSsid);
  const senderName = escapeHtml(params.senderName);

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
      <div style="background-color: #015E65; padding: 24px 32px;">
        <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: bold;">The WorkVilla</h1>
        <p style="color: #00AE6C; margin: 4px 0 0; font-size: 12px;">Your WiFi Access Code</p>
      </div>
      <div style="padding: 32px;">
        <p style="color: #1a1b1e; font-size: 15px;">Hello ${recipientName},</p>
        <p style="color: #333; font-size: 14px;">Here is your personal internet access code for The WorkVilla (Seat #${seatNumber}, Contract ${contractNumber}).</p>

        <!-- Voucher Code Box -->
        <div style="text-align: center; margin: 24px 0; padding: 20px; background: #f0faf5; border-radius: 8px; border: 2px solid #015E65;">
          <p style="color: #015E65; font-size: 13px; margin: 0 0 8px;">Your Voucher Code</p>
          <p style="color: #015E65; font-size: 32px; font-weight: bold; margin: 0; letter-spacing: 4px; font-family: monospace;">${voucherCode}</p>
        </div>

        <!-- Validity -->
        <table style="border-collapse: collapse; margin: 16px 0; width: 100%;">
          <tr>
            <td style="padding: 8px 16px; color: #666; font-size: 13px; border-bottom: 1px solid #e5e7eb;">Valid From</td>
            <td style="padding: 8px 16px; color: #333; font-size: 13px; font-weight: bold; border-bottom: 1px solid #e5e7eb; text-align: right;">${validFrom}</td>
          </tr>
          <tr>
            <td style="padding: 8px 16px; color: #666; font-size: 13px;">Valid Until</td>
            <td style="padding: 8px 16px; color: #333; font-size: 13px; font-weight: bold; text-align: right;">${validUntil}</td>
          </tr>
        </table>

        <!-- WiFi Instructions -->
        <div style="margin-top: 24px; padding: 16px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">
          <h3 style="color: #015E65; margin: 0 0 12px; font-size: 14px;">How to Connect</h3>
          <ol style="color: #555; font-size: 13px; margin: 0; padding-left: 20px; line-height: 1.8;">
            <li>Connect to the WiFi network: <strong style="color: #015E65;">${wifiSsid}</strong></li>
            <li>A login page will appear in your browser</li>
            <li>Enter the voucher code shown above</li>
            <li>Click <strong>Connect</strong> — you&apos;re online!</li>
          </ol>
          <p style="color: #888; font-size: 12px; margin: 12px 0 0;">This code is tied to your device. If you change your device, please contact The WorkVilla front desk for a replacement code.</p>
        </div>

        <!-- Renewal -->
        <div style="margin-top: 16px; padding: 16px; background: #f0faf5; border-radius: 6px; border: 1px solid #cfeadc;">
          <h3 style="color: #015E65; margin: 0 0 8px; font-size: 14px;">Need a new code?</h3>
          <p style="color: #555; font-size: 13px; margin: 0; line-height: 1.6;">Your code works until <strong>${validUntil}</strong>. If it expires or stops working before your contract ends on <strong>${contractEnd}</strong>, email <a href="mailto:${SUPPORT_EMAIL}" style="color: #015E65; font-weight: bold;">${SUPPORT_EMAIL}</a> and we will renew it for you. Renewals are available for as long as your contract is valid.</p>
        </div>

        <p style="color: #333; font-size: 14px; margin-top: 24px;">If you have any questions, please reach out to the front desk or email us.</p>
        <p style="color: #333; font-size: 14px;">Best regards,<br/><strong>${senderName}</strong><br/>The WorkVilla</p>
      </div>
      <div style="background-color: #015E65; padding: 16px 32px; text-align: center;">
        <p style="color: #ffffff; margin: 0; font-size: 11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
        <p style="color: rgba(255,255,255,0.7); margin: 4px 0 0; font-size: 10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | +91 97910 97900</p>
        <p style="color: rgba(255,255,255,0.7); margin: 4px 0 0; font-size: 10px;">GST: 33AAACU4245J1ZF</p>
        <p style="color: #00AE6C; margin: 4px 0 0; font-size: 10px;">www.theworkvilla.com</p>
      </div>
    </div>
  `;
}
