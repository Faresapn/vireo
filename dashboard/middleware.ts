import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Simple cookie-gate auth. Protects the whole app behind a login page.
// Credentials live in env (AUTH_USER / AUTH_PASS) — see .env.local.
const COOKIE = "vireo_auth";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Always allow: login page, the login API, Next internals, static assets.
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/login") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname === "/robots.txt"
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get(COOKIE)?.value;
  const expected = process.env.AUTH_TOKEN || "";

  if (!token || token !== expected) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // run on everything except static files
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
