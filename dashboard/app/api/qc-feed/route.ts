import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/qc-feed
// Global QC review feed: every video across ALL personas whose stage is
// 'qc' (awaiting review) or 'done' (approved = HASIL). One flat list the
// QC page groups by generate-date (gen_started_at) into a calendar.
export async function GET() {
  const rows = db()
    .prepare(
      `SELECT v.id, v.persona_id, v.stage, v.shortcode, v.duration_s,
              v.output_480, v.output_1080, v.gen_engine, v.gen_started_at,
              v.created_at, v.views, v.views_per_hour,
              p.name AS persona_name, p.niche, p.platform
       FROM videos v
       JOIN personas p ON p.id = v.persona_id
       WHERE v.stage IN ('qc','done')
       ORDER BY COALESCE(v.gen_started_at, v.created_at) DESC, v.id DESC`
    )
    .all() as any[];

  const items = rows.map((r) => {
    const rel = r.output_1080 || r.output_480 || "";
    // resolution from the output path (output/720p/..) — most accurate
    const m = rel.match(/output\/(\d+p)\//);
    const resolution = m ? m[1] : r.output_1080 ? "720p" : "480p";
    // engine label: internal 'seedance' always runs as Seedance 2.5
    const engRaw = r.gen_engine || "";
    const engine =
      engRaw === "seedance" || engRaw === "seedance-2.5"
        ? "Seedance 2.5"
        : engRaw === "wan-prime"
        ? "Wan Prime"
        : engRaw === "wan"
        ? "Wan 3.0"
        : engRaw === "genjutsu-light"
        ? "Genjutsu Light"
        : engRaw === "genjutsu"
        ? "Genjutsu"
        : engRaw || "—";
    // date used for the calendar (generate date; fallback to created)
    const whenRaw = r.gen_started_at || r.created_at || null;
    return {
      id: r.id,
      persona_id: r.persona_id,
      persona_name: r.persona_name,
      niche: r.niche,
      platform: r.platform,
      stage: r.stage, // 'qc' | 'done'
      shortcode: r.shortcode,
      duration_s: r.duration_s,
      resolution,
      engine,
      media: rel ? `/api/media/${r.persona_id}/${rel}` : null,
      when: whenRaw,
      views: r.views,
      views_per_hour: r.views_per_hour,
    };
  });

  return NextResponse.json({ items });
}
