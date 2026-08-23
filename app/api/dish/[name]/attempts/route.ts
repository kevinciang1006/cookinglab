import { NextResponse } from "next/server";
import { getAttemptsForDish, type Attempt } from "@/lib/cooking";

/**
 * GET /api/dish/[name]/attempts — every attempt logged for this dish,
 * newest first. Feeds the dish page's "attempt history" section (the flat
 * log, secondary to the saved recipe there).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const dish = decodeURIComponent(name);

  try {
    const attempts = await getAttemptsForDish(dish);
    return NextResponse.json<Attempt[]>([...attempts].reverse());
  } catch (err) {
    console.error("dish attempts failed:", err);
    return NextResponse.json({ error: "Couldn't load attempts for this dish." }, { status: 500 });
  }
}
