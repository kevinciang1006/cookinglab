import { NextResponse } from "next/server";
import { listDishActivity, type DishActivity } from "@/lib/cooking";

/**
 * GET /api/dishes — every dish with an attempt or a saved recipe, most
 * recently active first. Feeds the Recent tab's "Continue" section.
 */
export async function GET() {
  try {
    const dishes = await listDishActivity();
    return NextResponse.json<DishActivity[]>(dishes);
  } catch (err) {
    console.error("listDishActivity failed:", err);
    return NextResponse.json({ error: "Couldn't load dishes." }, { status: 500 });
  }
}
