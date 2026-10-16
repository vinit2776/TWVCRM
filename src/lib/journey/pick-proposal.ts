interface PickableProposal {
  id: string;
  status: string;
  superseded_by?: string | null;
}

const DEAD = ["rejected", "expired", "superseded"];

/**
 * If the requested proposal has been replaced by a revision, follow the chain to
 * the live one, so opening an old (superseded) proposal shows the journey of its
 * latest revision. Bounded in case of bad data.
 */
export function followRevisions<T extends PickableProposal>(proposals: T[], start: T | undefined): T | undefined {
  let current = start;
  for (let hops = 0; current && current.status === "superseded" && current.superseded_by && hops < 10; hops++) {
    const next = proposals.find((p) => p.id === current!.superseded_by);
    if (!next) break;
    current = next;
  }
  return current;
}

/** The proposal to show when nothing more specific was asked for: the newest live one. */
export function defaultProposal<T extends PickableProposal>(proposals: T[]): T | undefined {
  // `proposals` is newest first. Prefer a live proposal; fall back to a dead one
  // that isn't superseded; never a superseded one (its revision is the real one).
  return (
    proposals.find((p) => !DEAD.includes(p.status)) ??
    proposals.find((p) => p.status !== "superseded") ??
    undefined
  );
}
