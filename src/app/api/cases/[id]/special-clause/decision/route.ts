import { NextRequest } from "next/server";
import { decideClause } from "@/lib/special-clause/handlers";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return decideClause("case", (await params).id, request);
}
