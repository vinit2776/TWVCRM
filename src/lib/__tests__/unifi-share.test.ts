import { describe, it, expect } from "vitest";
import { buildShareableMessage } from "../unifi-share";

const base = { code: "2969635988", durationMinutes: 480, quota: 1, locationName: "Perungudi" };

describe("buildShareableMessage", () => {
  it("names the network the controller reported", () => {
    const msg = buildShareableMessage({ ...base, ssid: "Workvilla_Client" });
    expect(msg).toContain("Network:  Workvilla_Client");
    expect(msg).toContain('Connect to "Workvilla_Client"');
  });

  it("never names another site's network when the SSID is unknown", () => {
    for (const ssid of [null, "", "   "]) {
      const msg = buildShareableMessage({ ...base, ssid });
      expect(msg).not.toContain("WorkVilla Clients");
      expect(msg).not.toContain("Network:");
      expect(msg).toContain("Connect to the Perungudi guest WiFi");
      expect(msg).toContain("2969635988");
    }
  });
});
