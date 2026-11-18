import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Route handlers aren't unit-tested in this repo, so this guards the rule
// "no VO agreement is executed, stamped or re-papered before the case is paid"
// by asserting every such route calls the shared gate before doing its work.
const ROUTES = [
  "agreement/sign/route.ts",
  "leave-license/sign/route.ts",
  "leave-license/manual-sign/route.ts",
  "leave-license/stamp-sign-seal/route.ts",
  "leave-license/stamp-existing-document/route.ts",
  "leave-license/reupload-agreement/route.ts",
];

describe("VO execution payment gate coverage", () => {
  it.each(ROUTES)("%s calls checkVoExecutionPaymentGate", (route) => {
    const src = readFileSync(join(process.cwd(), "src/app/api/cases/[id]", route), "utf8");
    expect(src).toContain("checkVoExecutionPaymentGate(");
  });
});
