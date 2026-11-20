import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import {
  aggregatePettyCash,
  entriesToCsv,
  type AnalyticsRow,
} from "@/lib/petty-cash-analytics";

const PAGE = 1000;
const MAX_PAGES = 20; // 20k expenses; far beyond real volume, but bounds a runaway query
const LOW_BOOK_BALANCE = 1000;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z.object({
  date_from: day.optional(),
  date_to: day.optional(),
  person_id: z.string().uuid().optional(),
  category_id: z.string().uuid().optional(),
  location_id: z.string().uuid().optional(),
  format: z.enum(["json", "csv"]).optional(),
});

type Named = { id: string; name?: string; full_name?: string } | null;
// PostgREST returns a to-one join as an object, but typed clients may see an array.
const one = (v: unknown): Named => (Array.isArray(v) ? (v[0] ?? null) : ((v as Named) ?? null));

/**
 * GET /api/petty-cash/analytics
 * ?date_from&date_to&person_id&category_id&location_id[&format=csv]
 * Aggregates every approved expense matching the filters (not a page of them).
 * admin/manager/accounts see everyone; anyone else sees only their own spend.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  const f = parsed.data;

  const canViewAll = ["admin", "manager", "accounts"].includes(dbUser.role);

  const rows: AnalyticsRow[] = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = supabase
      .from("petty_cash_entries")
      .select(
        `entry_number, date, amount, description, category_id, location_id, submitted_by,
         category:petty_cash_categories!petty_cash_entries_category_id_fkey(id, name),
         submitter:users!petty_cash_entries_submitted_by_fkey(id, full_name),
         location:locations!petty_cash_entries_location_id_fkey(id, name)`
      )
      .eq("status", "approved")
      .order("date", { ascending: false })
      .order("entry_number", { ascending: false }) // stable order so pages never overlap
      .range(page * PAGE, page * PAGE + PAGE - 1);

    if (f.date_from) q = q.gte("date", f.date_from);
    if (f.date_to) q = q.lte("date", f.date_to);
    if (f.category_id) q = q.eq("category_id", f.category_id);
    if (f.location_id) q = q.eq("location_id", f.location_id);
    if (!canViewAll) q = q.eq("submitted_by", dbUser.id);
    else if (f.person_id) q = q.eq("submitted_by", f.person_id);

    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    for (const e of data ?? []) {
      rows.push({
        entry_number: e.entry_number,
        date: String(e.date).slice(0, 10),
        amount: Number(e.amount),
        description: e.description,
        category_id: e.category_id,
        category: one(e.category)?.name ?? null,
        person_id: e.submitted_by,
        person: one(e.submitter)?.full_name ?? "Unknown",
        location_id: e.location_id,
        location: one(e.location)?.name ?? null,
      });
    }
    if ((data?.length ?? 0) < PAGE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  if (f.format === "csv") {
    return new NextResponse(entriesToCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="petty-cash-${f.date_from ?? "all"}-to-${f.date_to ?? "now"}.csv"`,
      },
    });
  }

  // Filter dropdown options + cash in hand. Management only; everyone else just sees their own spend.
  let people: { id: string; name: string }[] = [];
  let locations: { id: string; name: string }[] = [];
  let cashInHand: { total: number; books: number; lowBooks: number } | null = null;
  if (canViewAll) {
    const [{ data: books }, { data: locs }] = await Promise.all([
      supabase.from("petty_cash_books")
        .select("current_balance, owner:users!petty_cash_books_user_id_fkey(id, full_name)"),
      supabase.from("locations").select("id, name").eq("is_active", true).order("name"),
    ]);
    people = (books ?? [])
      .map((b) => one(b.owner))
      .filter((o): o is NonNullable<Named> => !!o)
      .map((o) => ({ id: o.id, name: o.full_name ?? "Unknown" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    locations = (locs ?? []).map((l) => ({ id: l.id, name: l.name }));
    const balances = (books ?? []).map((b) => Number(b.current_balance));
    cashInHand = {
      total: balances.reduce((s, n) => s + n, 0),
      books: balances.length,
      lowBooks: balances.filter((n) => n < LOW_BOOK_BALANCE).length,
    };
  }

  return NextResponse.json({
    data: aggregatePettyCash(rows),
    options: { people, locations },
    cashInHand,
    truncated,
    scope: canViewAll ? "all" : "own",
  });
}
