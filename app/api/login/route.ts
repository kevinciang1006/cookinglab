import { NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, hashAppPassword, isRequestHttps } from "@/lib/auth";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/**
 * POST /api/login — body { password }. On match, sets an httpOnly cookie
 * holding the SHA-256 hash of APP_PASSWORD (never the raw password) that
 * middleware.ts checks on every other route.
 */
export async function POST(request: Request) {
  let password: unknown;
  try {
    const body = await request.json();
    password = body?.password;
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const appPassword = process.env.APP_PASSWORD;
  if (!appPassword) {
    return NextResponse.json(
      { ok: false, error: "Server isn't configured with a password yet." },
      { status: 500 }
    );
  }

  if (typeof password !== "string" || password !== appPassword) {
    return NextResponse.json({ ok: false, error: "Wrong password." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(AUTH_COOKIE_NAME, await hashAppPassword(appPassword), {
    httpOnly: true,
    secure: isRequestHttps(request),
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return response;
}
