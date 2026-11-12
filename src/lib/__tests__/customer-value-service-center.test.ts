import { describe, expect, it } from "vitest";
import { chooseServiceCenter, type ContractLocation } from "@/lib/customer-value/center-cohort";

// "ARC" sorts before "LGF", as Nungambakkam Arcade's id sorts before Nungambakkam LGF's.
const ARC = "a-arcade";
const LGF = "b-lgf";
let n = 0;
const c = (location_id: string | null, status: string, seats: number, start_date: string, activated = status !== "draft" && status !== "sent"): ContractLocation => ({
  id: `c${++n}`, lead_id: "l", location_id, status, seats, start_date, activated_at: activated ? `${start_date}T00:00:00Z` : null,
});

describe("chooseServiceCenter", () => {
  it("picks the center where live contracts hold the most seats, even when it sorts last", () => {
    expect(chooseServiceCenter([c(ARC, "active", 1, "2026-01-01"), c(LGF, "active", 4, "2026-02-01")])).toBe(LGF);
  });

  it("counts a renewal in progress as live", () => {
    expect(chooseServiceCenter([c(ARC, "terminated", 3, "2025-01-01"), c(LGF, "renewal_in_progress", 2, "2026-01-01")])).toBe(LGF);
  });

  it("ignores ended, renewed, draft and sent contracts while one is live", () => {
    expect(chooseServiceCenter([c(ARC, "active", 3, "2026-01-01"), c(LGF, "renewed", 4, "2025-01-01"), c(LGF, "terminated", 2, "2025-06-01"), c(LGF, "draft", 9, "2026-05-01"), c(LGF, "sent", 9, "2026-06-01")])).toBe(ARC);
  });

  it("on equal live seats, takes the center with the later start", () => {
    expect(chooseServiceCenter([c(ARC, "active", 2, "2026-01-01"), c(LGF, "active", 2, "2026-04-01")])).toBe(LGF);
  });

  it("with nothing live, takes the center of the contract that last actually ran", () => {
    expect(chooseServiceCenter([c(ARC, "terminated", 2, "2024-01-01"), c(LGF, "expired", 2, "2025-01-01"), c(ARC, "draft", 2, "2026-06-01")])).toBe(LGF);
  });

  it("with nothing live and nothing ever run, falls back to the first location", () => {
    expect(chooseServiceCenter([c(LGF, "draft", 2, "2026-01-01"), c(ARC, "sent", 2, "2026-02-01")])).toBe(ARC);
  });

  it("ignores contracts with no location, and is null with none", () => {
    expect(chooseServiceCenter([c(null, "active", 9, "2026-01-01"), c(LGF, "active", 1, "2026-01-01")])).toBe(LGF);
    expect(chooseServiceCenter([c(null, "active", 9, "2026-01-01")])).toBeNull();
    expect(chooseServiceCenter([])).toBeNull();
  });

  it("matches the three real customers with contracts at both Nungambakkam centers", () => {
    // CornerStone: Arcade active 1 seat (plus renewed, terminated); LGF renewed 4, terminated 1.
    expect(chooseServiceCenter([c(ARC, "active", 1, "2026-03-01"), c(ARC, "renewed", 1, "2025-03-01"), c(ARC, "terminated", 1, "2024-03-01"), c(LGF, "renewed", 4, "2025-01-01"), c(LGF, "terminated", 1, "2024-01-01")])).toBe(ARC);
    // The Open Realty: Arcade active 3 plus drafts; LGF terminated 2.
    expect(chooseServiceCenter([c(ARC, "active", 3, "2026-02-01"), c(ARC, "draft", 3, "2026-05-01"), c(ARC, "sent", 4, "2026-06-01"), c(LGF, "terminated", 2, "2025-01-01")])).toBe(ARC);
  });
});
