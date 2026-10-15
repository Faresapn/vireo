import { NextResponse } from "next/server";
import { execFile } from "child_process";
import path from "path";
import { STUDIO_ROOT } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/clusters — list available ViralEngine MCP clusters (niche categories).
// Calls scripts/mcp_client.mjs to fetch live clusters; falls back to a known list.
const KNOWN = [
  { slug: "animal-lover", name: "Animal Lover" },
  { slug: "f1-driver", name: "F1 Driver" },
  { slug: "red-bull", name: "Red Bull" },
  { slug: "anatoly", name: "Anatoly" },
  { slug: "scary", name: "Scary" },
  { slug: "koala", name: "Koala" },
  { slug: "fishing", name: "Fishing" },
  { slug: "asian-ashton-hall", name: "Asian Ashton Hall" },
  { slug: "time-travel", name: "Time Travel" },
  { slug: "general", name: "General" },
];

export async function GET() {
  const script = path.join(STUDIO_ROOT, "scripts", "mcp_client.mjs");
  const live = await new Promise<any[]>((resolve) => {
    execFile(
      "node",
      [script, "call", "list_instagram_signals", "{}"],
      { timeout: 30000, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const j = JSON.parse(stdout);
          const sc = j?.result?.structuredContent || j?.result || j;
          const clusters = (sc?.clusters || []).map((c: any) => ({
            slug: c.slug,
            name: c.name,
            total: c.total ?? null,
          }));
          resolve(clusters.length ? clusters : []);
        } catch {
          resolve([]);
        }
      }
    );
  });

  const clusters = live.length ? live : KNOWN;
  return NextResponse.json({ clusters, source: live.length ? "live" : "fallback" });
}
