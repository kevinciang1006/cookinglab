import { NextResponse } from "next/server";
import { getRecentAttempts, type Attempt } from "@/lib/cooking";

/**
 * GET /api/attempts — the 20 newest attempts, newest first (FR7).
 */
export async function GET() {
  try {
    const attempts = await getRecentAttempts();
    return NextResponse.json<Attempt[]>(attempts);
  } catch (err) {
    console.error("getRecentAttempts failed:", err);
    return NextResponse.json(
      { error: "Couldn't load recent cooks." },
      { status: 500 }
    );
  }
}
