import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/personas/[id]/insights
// RAG readout: what the system has learned about this persona's niche taste.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const persona = db().prepare("SELECT niche FROM personas WHERE id=?").get(id) as any;
  if (!persona) return NextResponse.json({ error: "not found" }, { status: 404 });
  const niche = persona.niche;

  // verdict tally for this niche
  const tally = db()
    .prepare(
      `SELECT verdict, COUNT(*) AS n FROM decisions WHERE niche=? GROUP BY verdict`
    )
    .all(niche) as any[];
  const counts: Record<string, number> = { ok: 0, revisi: 0, ulang: 0 };
  tally.forEach((t) => (counts[t.verdict] = t.n));
  const total = counts.ok + counts.revisi + counts.ulang;

  // first-try OK rate (drives auto-skip-480p decision)
  const firstTry = db()
    .prepare(
      `SELECT
         SUM(CASE WHEN verdict='ok' AND first_try=1 THEN 1 ELSE 0 END) AS ok1,
         SUM(CASE WHEN first_try=1 THEN 1 ELSE 0 END) AS tries
       FROM decisions WHERE niche=?`
    )
    .get(niche) as any;
  const firstTryRate = firstTry.tries ? firstTry.ok1 / firstTry.tries : 0;

  // engine win-rate for this niche (which engine gets OK more)
  const engines = db()
    .prepare(
      `SELECT engine,
         SUM(CASE WHEN verdict='ok' THEN 1 ELSE 0 END) AS ok,
         COUNT(*) AS n
       FROM decisions WHERE niche=? AND engine IS NOT NULL GROUP BY engine`
    )
    .all(niche) as any[];

  // ref-feature averages of OK vs rejected (what refs tend to win)
  const feat = db()
    .prepare(
      `SELECT verdict,
         AVG(duration_s) AS avg_dur,
         AVG(views_per_hour) AS avg_vph,
         COUNT(*) AS n
       FROM decisions WHERE niche=? GROUP BY verdict`
    )
    .all(niche) as any[];

  // winning prompts (OK) — recent, for reuse
  const winningPrompts = db()
    .prepare(
      `SELECT shortcode, engine, prompt, created_at
       FROM decisions WHERE niche=? AND verdict='ok' AND prompt IS NOT NULL AND LENGTH(prompt)>20
       ORDER BY created_at DESC LIMIT 5`
    )
    .all(niche) as any[];

  // recommendation: auto-skip 480p if first-try OK rate high enough with enough samples
  const autoSkip480 = firstTry.tries >= 10 && firstTryRate >= 0.9;
  const bestEngine =
    engines.length > 0
      ? engines.slice().sort((a, b) => (b.ok / b.n) - (a.ok / a.n))[0].engine
      : null;

  return NextResponse.json({
    niche,
    total_decisions: total,
    counts,
    ok_rate: total ? +(counts.ok / total).toFixed(2) : 0,
    first_try_ok_rate: +firstTryRate.toFixed(2),
    first_try_samples: firstTry.tries || 0,
    engines: engines.map((e) => ({
      engine: e.engine,
      ok: e.ok,
      total: e.n,
      win_rate: +(e.ok / e.n).toFixed(2),
    })),
    best_engine: bestEngine,
    ref_features: feat,
    winning_prompts: winningPrompts,
    recommendations: {
      auto_skip_480p: autoSkip480,
      preferred_engine: bestEngine,
      note: autoSkip480
        ? `Niche '${niche}' konsisten OK first-try (${(firstTryRate * 100).toFixed(0)}%). Aman langsung 1080p.`
        : `Belum cukup data / rate belum stabil (${total} keputusan). Tetap 480p draft dulu.`,
    },
  });
}
