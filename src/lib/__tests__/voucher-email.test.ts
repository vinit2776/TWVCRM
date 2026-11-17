import { describe, it, expect } from "vitest";
import {
  buildPerSeatEmailHTML,
  greetingName,
  wifiNetworkName,
  DEFAULT_WIFI_SSID,
  SUPPORT_EMAIL,
} from "@/lib/voucher-email";

const base = {
  recipientName: "A. Yamini Aruldoss",
  voucherCode: "1234-5678",
  validFrom: "13 Nov 2026",
  validUntil: "13 Nov 2027",
  contractEnd: "30 Jun 2029",
  wifiSsid: DEFAULT_WIFI_SSID,
  seatNumber: 2,
  contractNumber: "TWV-C-0160",
  senderName: "Vinit",
};

describe("greetingName", () => {
  it("prefers the member's name, then the customer's first name, never an email prefix", () => {
    expect(greetingName("A. Yamini Aruldoss", "Ravi")).toBe("A. Yamini Aruldoss");
    expect(greetingName(null, "Ravi")).toBe("Ravi");
    expect(greetingName("  ", null)).toBe("there");
  });
});

describe("wifiNetworkName", () => {
  it("defaults to Workvilla Clients when the location sets none", () => {
    expect(wifiNetworkName(null)).toBe("Workvilla Clients");
    expect(wifiNetworkName("  ")).toBe("Workvilla Clients");
    expect(wifiNetworkName("TWV Guest")).toBe("TWV Guest");
  });
});

describe("buildPerSeatEmailHTML", () => {
  it("greets by name, names the network and offers renewal until contract end", () => {
    const html = buildPerSeatEmailHTML(base);
    expect(html).toContain("Hello A. Yamini Aruldoss,");
    expect(html).toContain("Workvilla Clients");
    expect(html).toContain(`mailto:${SUPPORT_EMAIL}`);
    expect(html).toContain("30 Jun 2029");
    expect(html).toContain("1234-5678");
  });
  it("uses the location's network name", () => {
    expect(buildPerSeatEmailHTML({ ...base, wifiSsid: "TWV Guest" })).toContain("TWV Guest");
  });
  it("escapes names and network names so they cannot inject markup", () => {
    const html = buildPerSeatEmailHTML({ ...base, recipientName: "<b>x</b>", wifiSsid: '"><script>1</script>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
