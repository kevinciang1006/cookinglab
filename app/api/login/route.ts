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
  // TEMP DEBUG (login-auth-diagnosis, remove after): confirm APP_PASSWORD is
  // actually loaded in the deployed process — undefined here would make
  // every password "wrong" silently.
  console.log(`[login debug] APP_PASSWORD defined: ${appPassword !== undefined}`);
  if (!appPassword) {
    return NextResponse.json(
      { ok: false, error: "Server isn't configured with a password yet." },
      { status: 500 }
    );
  }

  const matched = typeof password === "string" && password === appPassword;
  // TEMP DEBUG (login-auth-diagnosis, remove after):
  console.log(`[login debug] password matched: ${matched}`);
  if (!matched) {
    return NextResponse.json({ ok: false, error: "Wrong password." }, { status: 401 });
  }

  const secure = isRequestHttps(request);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(AUTH_COOKIE_NAME, await hashAppPassword(appPassword), {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  // TEMP DEBUG (login-auth-diagnosis, remove after):
  console.log(`[login debug] cookie set — secure: ${secure}, sameSite: lax, path: /`);
  return response;
}
