import { NextRequest } from "next/server";
import { listClauses, submitClause } from "@/lib/special-clause/handlers";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return listClauses("contract", (await params).id);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return submitClause("contract", (await params).id, request);
}
