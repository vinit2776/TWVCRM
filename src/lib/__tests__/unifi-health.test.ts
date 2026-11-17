import { describe, it, expect } from "vitest";
import { internetState } from "../unifi-health";

describe("internetState", () => {
  it("treats UniFi's healthy value 'ok' as online (it used to show Degraded)", () => {
    expect(internetState("ok")).toBe("online");
    expect(internetState("OK")).toBe("online");
    expect(internetState("online")).toBe("online");
  });

  it("separates degraded from offline", () => {
    expect(internetState("warning")).toBe("degraded");
    expect(internetState("error")).toBe("offline");
    expect(internetState("offline")).toBe("offline");
  });

  it("does not claim an outage when the status is missing or unrecognised", () => {
    expect(internetState(undefined)).toBe("unknown");
    expect(internetState(null)).toBe("unknown");
    expect(internetState("unknown")).toBe("unknown");
    expect(internetState("something-new")).toBe("unknown");
  });
});
