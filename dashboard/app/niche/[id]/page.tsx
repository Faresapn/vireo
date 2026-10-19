"use client";
import { use } from "react";
import Studio from "../../components/Studio";

// "/niche/[id]" — opens the studio with that persona active.
export default function NichePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <Studio activeIdProp={id} />;
}
