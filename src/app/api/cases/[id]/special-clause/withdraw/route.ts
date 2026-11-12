import { NextRequest } from "next/server";
import { withdrawClause } from "@/lib/special-clause/handlers";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withdrawClause("case", (await params).id);
}
