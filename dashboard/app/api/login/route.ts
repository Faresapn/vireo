import { NextResponse } from "next/server";
import crypto from "crypto";

// POST /api/login { user, pass } -> sets auth cookie on success.
export async function POST(req: Request) {
  const { user, pass } = await req.json().catch(() => ({}));
  const U = process.env.AUTH_USER || "";
  const P = process.env.AUTH_PASS || "";
  const token = process.env.AUTH_TOKEN || "";

  if (!user || !pass || user !== U || pass !== P) {
    return NextResponse.json({ error: "User atau password salah" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set("vireo_auth", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 hari
  });
  return res;
}

// POST /api/login/logout handled separately; keep simple here.
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("vireo_auth", "", { path: "/", maxAge: 0 });
  return res;
}
