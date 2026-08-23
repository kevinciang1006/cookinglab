import { NextResponse } from "next/server";
import { deleteRecipe } from "@/lib/cooking";

/** DELETE /api/recipes/[id] — deletes one saved recipe (variation). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await deleteRecipe(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("recipe DELETE failed:", err);
    return NextResponse.json({ ok: false, error: "Couldn't delete — try again." }, { status: 500 });
  }
}
