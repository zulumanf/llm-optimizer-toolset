"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_MS = 3000;

/** Polls while a run is active so progress appears without manual reloads. */
export function RunLiveRefresh() {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [router]);
  return null;
}
