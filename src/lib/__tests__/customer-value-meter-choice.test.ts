import { describe, expect, it } from "vitest";
import { chooseMeter } from "@/lib/customer-value/meter-choice";

const on = { enabled: true, defaultDeviceId: "MAIN" };

describe("chooseMeter", () => {
  it("uses the center's OneGrid default when there is no connection row (the Nungambakkam LGF case)", () => {
    expect(chooseMeter([], on)).toEqual({ status: "ok", deviceId: "MAIN" });
    expect(chooseMeter([null], on)).toEqual({ status: "ok", deviceId: "MAIN" });
  });

  it("uses the single connection meter", () => {
    expect(chooseMeter(["A"], null)).toEqual({ status: "ok", deviceId: "A" });
    expect(chooseMeter(["A", "A"], on)).toEqual({ status: "ok", deviceId: "A" });
  });

  it("with several connection meters, accepts only the one the center's default names", () => {
    expect(chooseMeter(["A", "MAIN"], on)).toEqual({ status: "ok", deviceId: "MAIN" });
    expect(chooseMeter(["A", "B"], on)).toEqual({ status: "several_meters" });
    expect(chooseMeter(["A", "B"], null)).toEqual({ status: "several_meters" });
  });

  it("ignores a default device when OneGrid is switched off or none is set", () => {
    expect(chooseMeter([], { enabled: false, defaultDeviceId: "MAIN" })).toEqual({ status: "no_meter" });
    expect(chooseMeter([], { enabled: true, defaultDeviceId: null })).toEqual({ status: "no_meter" });
    expect(chooseMeter([], null)).toEqual({ status: "no_meter" });
  });
});
