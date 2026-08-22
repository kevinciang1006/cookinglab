// Shared by middleware.ts (Edge runtime) and app/api/login/route.ts — uses
// Web Crypto only (no node:crypto) so it works in both. Not "server-only"
// gated: middleware itself is never bundled into the client, and this file
// takes the password as a parameter rather than reading env vars directly.

export const AUTH_COOKIE_NAME = "cooking_lab_auth";

/** SHA-256 hex digest of `password` — what we store/compare in the cookie, so the raw password never sits in a browser-inspectable cookie value. */
export async function hashAppPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
