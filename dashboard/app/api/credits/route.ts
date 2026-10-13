import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Higgsfield pricing per second of INPUT video (from /estimate docs)
const PRICE = { "480p": 0.318, "720p": 0.681, "1080p": 1.632 };

// GET /api/credits  -> balance + spend summary
// POST /api/credits { topup: number }  -> add to balance
// Higgsfield doesn't expose balance via public API, so we track locally:
//   balance = sum(topups) - sum(estimated spend on successful gens)
export async function GET() {
  ensureTable();
  const topups = (db().prepare("SELECT COALESCE(SUM(amount),0) s FROM credit_ledger WHERE kind='topup'").get() as any).s;
  // estimated spend: successful videos (has output) * duration * price
  const vids = db().prepare(
    `SELECT duration_s, output_480, output_1080, gen_engine FROM videos
     WHERE output_480 IS NOT NULL OR output_1080 IS NOT NULL`
  ).all() as any[];
  let spend = 0;
  const perVideo: any[] = [];
  for (const v of vids) {
    const res = v.output_1080 ? "1080p" : "480p";
    const secs = Math.ceil(v.duration_s || 0);
    const cost = secs * (PRICE[res as keyof typeof PRICE] || 0);
    spend += cost;
    perVideo.push({ res, secs, cost: +cost.toFixed(2) });
  }
  const manualAdj = (db().prepare("SELECT COALESCE(SUM(amount),0) s FROM credit_ledger WHERE kind='adjust'").get() as any).s;
  const balance = topups + manualAdj - spend;

  return NextResponse.json({
    balance: +balance.toFixed(2),
    total_topup: +topups.toFixed(2),
    total_spend_est: +spend.toFixed(2),
    videos_charged: vids.length,
    pricing_per_sec: PRICE,
    note: "Saldo estimasi lokal (Higgsfield tak ekspos balance via API). Top-up manual saat isi credits di console.",
  });
}

export async function POST(req: NextRequest) {
  ensureTable();
  const body = await req.json();
  const amount = parseFloat(body.topup ?? body.amount);
  const kind = body.kind === "adjust" ? "adjust" : "topup";
  if (isNaN(amount)) return NextResponse.json({ error: "amount invalid" }, { status: 400 });
  db().prepare("INSERT INTO credit_ledger (kind, amount, note) VALUES (?,?,?)")
    .run(kind, amount, body.note || null);
  return NextResponse.json({ ok: true });
}

function ensureTable() {
  db().exec(`CREATE TABLE IF NOT EXISTS credit_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}
