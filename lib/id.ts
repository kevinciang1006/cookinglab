// Not "server-only" — this is imported from client components ("use client"
// files like app/components/shared.tsx) as well as anywhere server-side that
// just needs a random id.
//
// crypto.randomUUID() only exists in secure contexts (https:// or
// localhost) — this app is also served over plain http:// on a LAN IP
// (confirmed root cause of "crypto.randomUUID is not a function" there),
// where the browser doesn't expose it at all. generateId() falls back to a
// manually-built UUID v4 using crypto.getRandomValues(), which is NOT
// secure-context-gated and works over plain http, and as a last resort to a
// non-cryptographic id if even that's unavailable. These ids are only ever
// used as React keys / chat-turn identifiers — never anything
// security-sensitive — so the fallback's weaker randomness is fine.

/** Builds a v4 UUID from 16 random bytes (RFC 4122 §4.4: set the version/variant bits). */
function uuidFromRandomBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Generates a random id — crypto.randomUUID() when available, safe fallbacks otherwise. */
export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    return uuidFromRandomBytes(crypto.getRandomValues(new Uint8Array(16)));
  }

  // Last resort — not cryptographically random, but these ids are never
  // used for anything security-sensitive.
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
