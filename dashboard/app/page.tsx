"use client";
import Studio from "./components/Studio";

// Home "/" — overview; no persona selected yet.
export default function HomePage() {
  return <Studio activeIdProp={null} />;
}
