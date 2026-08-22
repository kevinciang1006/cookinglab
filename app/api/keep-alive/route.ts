import { NextResponse } from "next/server";
import { pingDatabase } from "@/lib/cooking";

/**
 * GET /api/keep-alive — hit by the Vercel cron (vercel.json) daily so
 * Supabase's free-tier project doesn't pause for inactivity.
 */
export async function GET() {
  try {
    await pingDatabase();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("keep-alive failed:", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
