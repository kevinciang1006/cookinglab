import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, hashAppPassword } from "@/lib/auth";

/**
 * Simple password gate. Protects everything except /login, /api/login,
 * /api/keep-alive, and static/PWA assets (see `config.matcher` below).
 * If APP_PASSWORD isn't set server-side, the gate fails closed (redirects
 * to /login) rather than silently letting traffic through.
 */
export async function middleware(request: NextRequest) {
  const appPassword = process.env.APP_PASSWORD;
  const cookie = request.cookies.get(AUTH_COOKIE_NAME)?.value;

  if (appPassword && cookie) {
    const expected = await hashAppPassword(appPassword);
    if (cookie === expected) {
      // TEMP DEBUG (login-auth-diagnosis, remove after):
      console.log(`[middleware debug] ${request.nextUrl.pathname} — authed, passing through`);
      return NextResponse.next();
    }
  }

  // TEMP DEBUG (login-auth-diagnosis, remove after):
  console.log(
    `[middleware debug] ${request.nextUrl.pathname} — NOT authed (cookiePresent: ${cookie !== undefined}, appPasswordSet: ${appPassword !== undefined}) — redirecting to /login`
  );
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icon-192|icon-512|apple-icon|login|api/login|api/keep-alive).*)",
  ],
};
