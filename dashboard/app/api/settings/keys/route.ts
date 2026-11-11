import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";
import { viaGo } from "@/lib/goBackend";

export const dynamic = "force-dynamic";

// Higgsfield API keys live in two files in the home dir; every render script
// reads them fresh at start, so a change applies to the next render.
//   wan      ~/.higgsfield_key   -> wan-prime, wan, genjutsu-light
//   seedance ~/.higgsfield_key2  -> seedance-2.5, genjutsu
const SLOTS = {
  wan: { file: ".higgsfield_key", engines: "Wan 3.0 Prime, Wan, Genjutsu Light" },
  seedance: { file: ".higgsfield_key2", engines: "Seedance 2.5, Genjutsu" },
} as const;
type Slot = keyof typeof SLOTS;

// Higgsfield keys are "<uuid>:<secret>".
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[A-Za-z0-9]{16,}$/i;

const keyPath = (slot: Slot) => path.join(os.homedir(), SLOTS[slot].file);

function readKey(slot: Slot): string {
  try { return fs.readFileSync(keyPath(slot), "utf8").trim(); } catch { return ""; }
}

function mask(key: string) {
  if (!key) return null;
  const [id] = key.split(":");
  return `${id.slice(0, 8)}…${key.slice(-4)}`;
}

// A status lookup for a request that doesn't exist answers 404 for a valid key
// and 401 for a bad one, without charging anything.
async function checkKey(key: string): Promise<"valid" | "invalid" | "unknown"> {
  try {
    const r = await fetch("https://api.higgsfield.ai/requests/00000000-0000-0000-0000-000000000000/status", {
      headers: { Authorization: `Key ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 401 || r.status === 403) return "invalid";
    if (r.status === 404 || r.ok) return "valid";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function describe(slot: Slot) {
  const key = readKey(slot);
  let updated: string | null = null;
  try { updated = fs.statSync(keyPath(slot)).mtime.toISOString(); } catch {}
  return { slot, file: `~/${SLOTS[slot].file}`, engines: SLOTS[slot].engines, set: !!key, masked: mask(key), updated };
}

// GET /api/settings/keys?check=1 -> masked keys (+ live validity when check=1)
export async function GET(req: NextRequest) {
  const go = await viaGo(req, `/api/settings/keys${req.nextUrl.search}`);
  if (go) return go;
  const check = req.nextUrl.searchParams.get("check") === "1";
  const out = await Promise.all((Object.keys(SLOTS) as Slot[]).map(async (slot) => {
    const d: any = describe(slot);
    if (check && d.set) d.status = await checkKey(readKey(slot));
    return d;
  }));
  return NextResponse.json({ keys: out });
}

// POST /api/settings/keys { slot: "wan"|"seedance", key }
// Validates the key against Higgsfield before saving; the old key is kept as <file>.bak.
export async function POST(req: NextRequest) {
  const go = await viaGo(req, "/api/settings/keys");
  if (go) return go;
  const body = await req.json().catch(() => ({}));
  const slot = body.slot as Slot;
  const key = String(body.key || "").trim();
  if (!(slot in SLOTS)) return NextResponse.json({ error: "slot harus wan atau seedance" }, { status: 400 });
  if (!KEY_RE.test(key)) return NextResponse.json({ error: "Format key salah. Harus <id>:<secret> dari Higgsfield." }, { status: 400 });

  const status = await checkKey(key);
  if (status === "invalid") return NextResponse.json({ error: "Key ditolak Higgsfield (401). Tidak disimpan." }, { status: 400 });

  const file = keyPath(slot);
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, key + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return NextResponse.json({ ok: true, status, key: describe(slot) });
}
