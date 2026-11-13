import { describe, it, expect } from "vitest";
import {
  autoFlags,
  gstinMatchesPan,
  maskAadhaar,
  namesMatch,
  normalizeCompanyName,
  panFromGstin,
  panMatchesEntity,
  panSurnameInitialMatches,
  validateAadhaar,
  validateCin,
  validateGstin,
  validateLlpin,
  validatePan,
  type Flag,
  type KycFlagInput,
} from "../vo-kyc-validators";

// Test helpers: build valid numbers instead of hardcoding unverified ones.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

function withVerhoeffDigit(payload: string): string {
  let c = 0;
  const reversed = payload.split("").reverse();
  reversed.forEach((ch, i) => {
    c = D[c][P[(i + 1) % 8][Number(ch)]];
  });
  return payload + INV[c];
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function withGstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = ALPHABET.indexOf(first14[i]) * (i % 2 === 1 ? 2 : 1);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return first14 + ALPHABET[(36 - (sum % 36)) % 36];
}

const VALID_AADHAAR = withVerhoeffDigit("23456789012");
const COMPANY_PAN = "AAACT1234F"; // 4th letter C
const SIGNATORY_PAN = "ABCPS1234K"; // 4th letter P, surname starts with S
const COMPANY_GSTIN = withGstinCheckChar(`27${COMPANY_PAN}1Z`);

function flagFor(flags: Flag[], code: string): Flag | undefined {
  return flags.find((f) => f.code === code);
}

describe("validatePan", () => {
  it("accepts a well-formed PAN and reads the holder type", () => {
    expect(validatePan("ABCPS1234K")).toEqual({ valid: true, holderType: "P", issues: [] });
    expect(validatePan("aaacz1234f").holderType).toBe("C");
  });

  it("normalises case and spaces", () => {
    expect(validatePan(" abcps 1234k ").valid).toBe(true);
  });

  it("rejects bad formats", () => {
    for (const bad of ["", "ABCPS1234", "ABCPS12345", "1BCPS1234K", "ABCPS1234KK"]) {
      const result = validatePan(bad);
      expect(result.valid).toBe(false);
      expect(result.holderType).toBeNull();
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it("rejects an unknown holder letter", () => {
    expect(validatePan("ABCXS1234K").valid).toBe(false);
  });
});

describe("panMatchesEntity", () => {
  it("matches expected holder types", () => {
    expect(panMatchesEntity("pvt_ltd", "AAACT1234F")).toBe(true);
    expect(panMatchesEntity("public_ltd", "AAACT1234F")).toBe(true);
    expect(panMatchesEntity("individual", "ABCPS1234K")).toBe(true);
    expect(panMatchesEntity("proprietorship", "ABCPS1234K")).toBe(true);
    expect(panMatchesEntity("partnership", "AAAFT1234F")).toBe(true);
    expect(panMatchesEntity("llp", "AAAFT1234F")).toBe(true);
    expect(panMatchesEntity("huf", "AAAHT1234F")).toBe(true);
    expect(panMatchesEntity("trust", "AAATT1234F")).toBe(true);
  });

  it("rejects the wrong holder type", () => {
    expect(panMatchesEntity("pvt_ltd", "ABCPS1234K")).toBe(false);
    expect(panMatchesEntity("individual", "AAACT1234F")).toBe(false);
    expect(panMatchesEntity("llp", "AAACT1234F")).toBe(false);
  });

  it("rejects an invalid PAN and allows any valid PAN for unrestricted types", () => {
    expect(panMatchesEntity("pvt_ltd", "bad")).toBe(false);
    expect(panMatchesEntity("society", "AAAAT1234F")).toBe(true);
    expect(panMatchesEntity("other", "AAACT1234F")).toBe(true);
  });
});

describe("panSurnameInitialMatches", () => {
  it("matches the last word of the name against the 5th character", () => {
    expect(panSurnameInitialMatches("ABCPS1234K", "Rahul Kumar Sharma")).toBe(true);
    expect(panSurnameInitialMatches("abcps1234k", "Mr. Rahul Sharma")).toBe(true);
  });

  it("flags a different initial", () => {
    expect(panSurnameInitialMatches("ABCPS1234K", "Rahul Verma")).toBe(false);
  });

  it("is false for non-person PANs, bad PANs and empty names", () => {
    expect(panSurnameInitialMatches("AAACS1234F", "Rahul Sharma")).toBe(false);
    expect(panSurnameInitialMatches("bad", "Rahul Sharma")).toBe(false);
    expect(panSurnameInitialMatches("ABCPS1234K", "  ")).toBe(false);
  });
});

describe("validateGstin", () => {
  it("accepts the known valid example", () => {
    expect(validateGstin("27AAPFU0939F1ZV")).toEqual({ valid: true, issues: [] });
  });

  it("accepts a generated GSTIN and lowercase input", () => {
    expect(validateGstin(COMPANY_GSTIN).valid).toBe(true);
    expect(validateGstin(COMPANY_GSTIN.toLowerCase()).valid).toBe(true);
  });

  it("rejects a changed check character", () => {
    const result = validateGstin("27AAPFU0939F1ZW");
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("rejects bad length and format", () => {
    expect(validateGstin("27AAPFU0939F1Z").valid).toBe(false);
    expect(validateGstin("").valid).toBe(false);
    expect(validateGstin("27AAPFU0939F1XV").valid).toBe(false);
  });

  it("rejects an unknown state code even with a correct check character", () => {
    expect(validateGstin(withGstinCheckChar("00AAPFU0939F1Z")).valid).toBe(false);
    expect(validateGstin(withGstinCheckChar("39AAPFU0939F1Z")).valid).toBe(false);
  });

  it("accepts state codes 01, 38, 97 and 99", () => {
    for (const code of ["01", "38", "97", "99"]) {
      expect(validateGstin(withGstinCheckChar(`${code}AAPFU0939F1Z`)).valid).toBe(true);
    }
  });

  it("rejects an embedded PAN with a bad holder type", () => {
    expect(validateGstin(withGstinCheckChar("27AAPXU0939F1Z")).valid).toBe(false);
  });
});

describe("panFromGstin and gstinMatchesPan", () => {
  it("extracts the PAN", () => {
    expect(panFromGstin("27AAPFU0939F1ZV")).toBe("AAPFU0939F");
    expect(panFromGstin("short")).toBeNull();
    expect(panFromGstin("27!!!!!0939F1ZV")).toBeNull();
  });

  it("compares with a PAN", () => {
    expect(gstinMatchesPan("27AAPFU0939F1ZV", "aapfu0939f")).toBe(true);
    expect(gstinMatchesPan("27AAPFU0939F1ZV", "AAPFU0939G")).toBe(false);
    expect(gstinMatchesPan("short", "AAPFU0939F")).toBe(false);
  });
});

describe("validateAadhaar", () => {
  it("accepts a generated valid number, with or without spaces", () => {
    expect(validateAadhaar(VALID_AADHAAR).valid).toBe(true);
    const spaced = `${VALID_AADHAAR.slice(0, 4)} ${VALID_AADHAAR.slice(4, 8)} ${VALID_AADHAAR.slice(8)}`;
    expect(validateAadhaar(spaced)).toEqual({ valid: true, issues: [] });
  });

  it("rejects a wrong check digit", () => {
    const last = Number(VALID_AADHAAR[11]);
    const bad = VALID_AADHAAR.slice(0, 11) + ((last + 1) % 10);
    expect(validateAadhaar(bad).valid).toBe(false);
  });

  it("rejects a first digit of 0 or 1", () => {
    expect(validateAadhaar(withVerhoeffDigit("12345678901")).valid).toBe(false);
    expect(validateAadhaar(withVerhoeffDigit("02345678901")).valid).toBe(false);
  });

  it("rejects wrong length and non-digits", () => {
    expect(validateAadhaar("12345").valid).toBe(false);
    expect(validateAadhaar("").valid).toBe(false);
    expect(validateAadhaar(`${VALID_AADHAAR.slice(0, 11)}X`).valid).toBe(false);
  });

  it("never puts the full number in the issues", () => {
    const bad = VALID_AADHAAR.slice(0, 11) + ((Number(VALID_AADHAAR[11]) + 1) % 10);
    const text = validateAadhaar(bad).issues.join(" ");
    expect(text).not.toContain(bad);
    expect(text).not.toContain(bad.slice(0, 8));
  });
});

describe("maskAadhaar", () => {
  it("keeps only the last 4 digits", () => {
    expect(maskAadhaar("2345 6789 1234")).toBe("XXXX XXXX 1234");
    expect(maskAadhaar("234567891234")).toBe("XXXX XXXX 1234");
  });

  it("fully masks input that is too short or not numeric", () => {
    expect(maskAadhaar("12")).toBe("XXXX XXXX XXXX");
    expect(maskAadhaar("abcd")).toBe("XXXX XXXX XXXX");
  });
});

describe("validateCin", () => {
  it("accepts a well-formed CIN", () => {
    expect(validateCin("U74999MH2020PTC123456")).toEqual({ valid: true, issues: [] });
    expect(validateCin("l12345dl1999plc654321").valid).toBe(true);
  });

  it("rejects bad CINs", () => {
    for (const bad of ["", "X74999MH2020PTC123456", "U74999MH2020PTC12345", "U7499MH2020PTC123456", "U74999M12020PTC123456"]) {
      expect(validateCin(bad).valid).toBe(false);
    }
  });
});

describe("validateLlpin", () => {
  it("accepts AAA-1234", () => {
    expect(validateLlpin("AAB-1234").valid).toBe(true);
    expect(validateLlpin("aab-1234").valid).toBe(true);
  });

  it("rejects other shapes", () => {
    for (const bad of ["", "AAB1234", "AA-1234", "AAB-123", "AAB-12345", "123-ABCD"]) {
      expect(validateLlpin(bad).valid).toBe(false);
    }
  });
});

describe("normalizeCompanyName", () => {
  it("ignores case, punctuation and legal suffixes", () => {
    expect(normalizeCompanyName("The Acme  Pvt. Ltd.")).toBe("THE ACME");
    expect(normalizeCompanyName("Acme Private Limited")).toBe("ACME");
    expect(normalizeCompanyName("Acme LLP")).toBe("ACME");
  });

  it("handles ampersands and common variants", () => {
    expect(normalizeCompanyName("Shah & Sons")).toBe("SHAH AND SONS");
    expect(normalizeCompanyName("Acme Technologies")).toBe("ACME TECHNOLOGY");
  });

  it("copes with empty input", () => {
    expect(normalizeCompanyName("")).toBe("");
  });
});

describe("namesMatch", () => {
  it("matches the same name written differently", () => {
    expect(namesMatch("WorkVilla Private Limited", "WORK VILLA PVT. LTD.")).toEqual({ score: 1, match: true });
    expect(namesMatch("Acme Technologies Pvt Ltd", "Acme Technology Private Limited").match).toBe(true);
  });

  it("tolerates a small typo", () => {
    const result = namesMatch("Brightwave Solutions Pvt Ltd", "Brightwav Solutions Private Limited");
    expect(result.match).toBe(true);
    expect(result.score).toBeLessThan(1);
  });

  it("does not match different names", () => {
    const result = namesMatch("Acme Traders Pvt Ltd", "Zenith Logistics Pvt Ltd");
    expect(result.match).toBe(false);
    expect(result.score).toBeLessThan(0.5);
  });

  it("scores empty names as zero", () => {
    expect(namesMatch("", "Acme")).toEqual({ score: 0, match: false });
    expect(namesMatch("Pvt Ltd", "Acme")).toEqual({ score: 0, match: false });
  });
});

describe("autoFlags", () => {
  const clean: KycFlagInput = {
    entityType: "pvt_ltd",
    companyName: "Acme Technologies Pvt Ltd",
    mcaName: "ACME TECHNOLOGIES PRIVATE LIMITED",
    companyPan: COMPANY_PAN,
    gstin: COMPANY_GSTIN,
    signatoryName: "Rahul Sharma",
    signatoryPan: SIGNATORY_PAN,
    signatoryAadhaar: VALID_AADHAAR,
    cin: "U74999MH2020PTC123456",
    certificateIssuedOn: "2026-06-01",
    today: "2026-11-11",
  };

  it("gives only ok and info flags for clean input", () => {
    const flags = autoFlags(clean);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((f) => f.severity === "ok" || f.severity === "info")).toBe(true);
  });

  it("returns nothing for empty optional input", () => {
    expect(autoFlags({ entityType: "pvt_ltd", companyName: "Acme" })).toEqual([]);
  });

  it("serious: company PAN format invalid", () => {
    const flags = autoFlags({ ...clean, companyPan: "BAD" });
    expect(flagFor(flags, "company_pan_format")?.severity).toBe("serious");
    expect(flagFor(flags, "company_pan_entity")).toBeUndefined();
  });

  it("serious: GSTIN checksum invalid", () => {
    const bad = COMPANY_GSTIN.slice(0, 14) + (COMPANY_GSTIN[14] === "A" ? "B" : "A");
    const flags = autoFlags({ ...clean, gstin: bad });
    expect(flagFor(flags, "gstin_invalid")?.severity).toBe("serious");
  });

  it("serious: company PAN holder type does not match entity type", () => {
    const flags = autoFlags({ ...clean, entityType: "llp" });
    expect(flagFor(flags, "company_pan_entity")?.severity).toBe("serious");
  });

  it("serious: signatory PAN is not a person PAN", () => {
    const flags = autoFlags({ ...clean, signatoryPan: "AAACS1234F" });
    expect(flagFor(flags, "signatory_pan_holder")?.severity).toBe("serious");
    expect(flagFor(flags, "signatory_surname")).toBeUndefined();
  });

  it("serious: signatory PAN format invalid", () => {
    const flags = autoFlags({ ...clean, signatoryPan: "nope" });
    expect(flagFor(flags, "signatory_pan_format")?.severity).toBe("serious");
  });

  it("serious: PAN inside GSTIN differs from company PAN", () => {
    const flags = autoFlags({ ...clean, companyPan: "AAACZ9999Z" });
    expect(flagFor(flags, "gstin_pan_mismatch")?.severity).toBe("serious");
  });

  it("warning: signatory surname initial does not match", () => {
    const flags = autoFlags({ ...clean, signatoryName: "Rahul Verma" });
    expect(flagFor(flags, "signatory_surname")?.severity).toBe("warning");
  });

  it("warning: company name differs from MCA name", () => {
    const flags = autoFlags({ ...clean, mcaName: "Zenith Logistics Private Limited" });
    expect(flagFor(flags, "company_name_mca")?.severity).toBe("warning");
  });

  it("warning: certificate older than 12 months, ok at the boundary", () => {
    expect(flagFor(autoFlags({ ...clean, certificateIssuedOn: "2025-11-10" }), "certificate_age")?.severity).toBe("warning");
    expect(flagFor(autoFlags({ ...clean, certificateIssuedOn: "2025-11-11" }), "certificate_age")?.severity).toBe("ok");
  });

  it("info: unreadable certificate date", () => {
    expect(flagFor(autoFlags({ ...clean, certificateIssuedOn: "last week" }), "certificate_age")?.severity).toBe("info");
  });

  it("info: Aadhaar is stored masked and the full number never appears", () => {
    const flags = autoFlags(clean);
    const masked = flagFor(flags, "aadhaar_masked");
    expect(masked?.severity).toBe("info");
    expect(masked?.message).toContain(VALID_AADHAAR.slice(-4));
    expect(JSON.stringify(flags)).not.toContain(VALID_AADHAAR);
    expect(JSON.stringify(flags)).not.toContain(VALID_AADHAAR.slice(0, 8));
  });

  it("warning: bad Aadhaar check digit and bad CIN", () => {
    const badAadhaar = VALID_AADHAAR.slice(0, 11) + ((Number(VALID_AADHAAR[11]) + 1) % 10);
    const flags = autoFlags({ ...clean, signatoryAadhaar: badAadhaar, cin: "bad" });
    expect(flagFor(flags, "aadhaar_check")?.severity).toBe("warning");
    expect(flagFor(flags, "cin_format")?.severity).toBe("warning");
    expect(JSON.stringify(flags)).not.toContain(badAadhaar);
  });

  it("emits ok flags for each passing check", () => {
    const codes = autoFlags(clean).filter((f) => f.severity === "ok").map((f) => f.code);
    for (const code of [
      "company_pan_format", "company_pan_entity", "gstin_invalid", "gstin_pan_mismatch",
      "signatory_pan_format", "signatory_pan_holder", "signatory_surname", "aadhaar_check",
      "cin_format", "company_name_mca", "certificate_age",
    ]) {
      expect(codes).toContain(code);
    }
  });

  it("keeps messages free of em dashes", () => {
    const messages = autoFlags({ ...clean, companyPan: "BAD", gstin: "x", signatoryPan: "y", cin: "z", mcaName: "Other" });
    expect(messages.every((f) => !f.message.includes("—"))).toBe(true);
  });
});
