import Link from "next/link";

const TABS = [
  { key: "overview", href: "/automation", label: "Overview" },
  { key: "workflows", href: "/automation/workflows", label: "Workflows" },
  { key: "runs", href: "/automation/runs", label: "Runs" },
  { key: "connectors", href: "/automation/connectors", label: "Connectors" },
  { key: "triggers", href: "/automation/triggers", label: "Triggers" },
  { key: "events", href: "/automation/events", label: "Events" },
  { key: "outreach", href: "/automation/outreach", label: "Outreach" },
] as const;

export function AutomationNav({ current }: { current: string }) {
  return (
    <nav className="mb-6 flex flex-wrap gap-1 border-b" aria-label="Automation sections">
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === current ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
            tab.key === current
              ? "border-foreground font-medium"
              : "border-transparent text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground"
          }`}
        >
          {tab.label}
        </Link>
      ))}
      <Link
        href="/control-tower"
        className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
      >
        Control tower →
      </Link>
    </nav>
  );
}
