import DishPageClient from "./DishPageClient";

export default async function DishPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const dish = decodeURIComponent(name);
  return <DishPageClient dish={dish} />;
}
