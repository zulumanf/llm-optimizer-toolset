"use client";

import Link from "next/link";
import { PageTabs } from "@/components/layout/page-tabs";

/**
 * Automation section tabs — rendered via the shared PageTabs bar (cleanup
 * 2026-08-18; this was one of three hand-rolled copies of the same
 * underline nav). Active state derives from the pathname, so run/workflow
 * detail pages light up their parent tab without a prop.
 */
const TABS = [
  { href: "/automation", label: "Overview", exact: true },
  { href: "/automation/workflows", label: "Workflows" },
  { href: "/automation/runs", label: "Runs" },
  { href: "/automation/connectors", label: "Connectors" },
  { href: "/automation/triggers", label: "Triggers" },
  { href: "/automation/events", label: "Events" },
  { href: "/automation/outreach", label: "Outreach" },
];

export function AutomationNav() {
  return (
    <PageTabs
      tabs={TABS}
      trailing={
        <Link
          href="/control-tower"
          className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
        >
          Control tower &rarr;
        </Link>
      }
    />
  );
}
