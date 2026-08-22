import { NextResponse } from "next/server";
import { getDishMemory, type DishMemory } from "@/lib/cooking";

export type DishMemoryResponse = DishMemory;

/**
 * GET /api/dish/[name]/memory — cached "what I know about this dish"
 * summary, plus its attempt count. Serves the cache (recipes.notes);
 * generates it on first view if nothing's cached yet. `bullets: null` means
 * the dish has no attempts.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const dish = decodeURIComponent(name);

  try {
    const memory = await getDishMemory(dish);
    return NextResponse.json<DishMemoryResponse>(memory);
  } catch (err) {
    console.error("dish memory failed:", err);
    return NextResponse.json<DishMemoryResponse>({ bullets: null, attemptCount: 0 }, { status: 500 });
  }
}
