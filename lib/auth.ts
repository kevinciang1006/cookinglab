// Shared by middleware.ts (Edge runtime) and app/api/login/route.ts — uses
// Web Crypto only (no node:crypto) so it works in both. Not "server-only"
// gated: middleware itself is never bundled into the client, and this file
// takes the password as a parameter rather than reading env vars directly.

export const AUTH_COOKIE_NAME = "cooking_lab_auth";

/**
 * True if this request actually arrived over HTTPS. Deliberately NOT based
 * on NODE_ENV — `next start` sets NODE_ENV=production for every production
 * deployment, including a plain-HTTP LAN box, so that's not a reliable proxy
 * for "should this cookie be Secure?" (confirmed root cause of a broken
 * login on the LAN pm2 deployment: NODE_ENV=production but no TLS, so a
 * Secure cookie was set and every browser silently dropped it).
 * Checks x-forwarded-proto first (sniffed correctly by Vercel/reverse
 * proxies that terminate TLS in front of the app), falling back to the
 * request URL's own protocol for a direct, unproxied connection.
 */
export function isRequestHttps(request: Request): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto) return forwardedProto.split(",")[0].trim() === "https";
  return new URL(request.url).protocol === "https:";
}

/** SHA-256 hex digest of `password` — what we store/compare in the cookie, so the raw password never sits in a browser-inspectable cookie value. */
export async function hashAppPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
