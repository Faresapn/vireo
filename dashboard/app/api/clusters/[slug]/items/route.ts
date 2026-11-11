import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import path from "path";
import { STUDIO_ROOT } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/clusters/[slug]/items -> list viral items in a cluster (for Motion
// Control ref picker). Returns shortcode + source_url + duration per item.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const script = path.join(STUDIO_ROOT, "scripts", "mcp_client.mjs");
  const args = ["call", "list_instagram_signals", JSON.stringify({ cluster: slug, order: "velocity", limit: 12, offset: 0 })];

  const items = await new Promise<any[]>((resolve) => {
    execFile("node", [script, ...args], { timeout: 30000, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const j = JSON.parse(stdout);
        const sc = j?.result?.structuredContent || j?.result || j;
        const cluster = sc?.clusters?.[0];
        const list = (cluster?.items || []).map((it: any) => ({
          shortcode: it.shortcode || it.code || null,
          source_url: it.video_url || it.url || it.source_url || it.permalink || null,
          duration_s: it.duration_s || it.duration || null,
          views: it.views || null,
          views_per_hour: it.views_per_hour || null,
        })).filter((x: any) => x.source_url);
        resolve(list);
      } catch { resolve([]); }
    });
  });

  return NextResponse.json({ items });
}
