/**
 * The project section list — one definition, two consumers.
 *
 * The sidebar and the command palette each held their own copy, so adding a
 * section meant remembering both. That is the same failure the page primitives
 * exist to prevent, one layer up: a rule with two implementations has no rule.
 *
 * Order is the operator's reading order, not alphabetical: what is the state of
 * this client (Dashboard, Plan), what do we know (Knowledge), what did we
 * measure (Prompts → Runs → Review), what did it tell us (Gaps, Accuracy), and
 * what are we doing about it (Content → Competitors → Reports → Tasks).
 */
import {
  BookOpen,
  CheckCheck,
  ClipboardCheck,
  Crosshair,
  FileEdit,
  FileText,
  Flag,
  FlaskConical,
  LayoutDashboard,
  ListTodo,
  Map as MapIcon,
  MessageSquareText,
  PlayCircle,
  Settings,
  ShieldAlert,
  Swords,
  type LucideIcon,
} from "lucide-react";

export interface ProjectSection {
  /** Appended to /projects/{id}. Empty string is the client dashboard. */
  path: string;
  label: string;
  icon: LucideIcon;
}

export const PROJECT_SECTIONS: ProjectSection[] = [
  { path: "", label: "Dashboard", icon: LayoutDashboard },
  // Second because it answers "what are we doing for this client?" — the
  // question asked most often, and previously three clicks deep.
  { path: "/plan", label: "Plan", icon: MapIcon },
  { path: "/knowledge", label: "Knowledge", icon: BookOpen },
  { path: "/prompts", label: "Prompts", icon: MessageSquareText },
  { path: "/runs", label: "Runs", icon: PlayCircle },
  { path: "/review", label: "Review", icon: CheckCheck },
  { path: "/gaps", label: "Gaps", icon: Crosshair },
  { path: "/accuracy", label: "Accuracy", icon: ShieldAlert },
  { path: "/content", label: "Content", icon: FileEdit },
  { path: "/competitors", label: "Competitors", icon: Swords },
  { path: "/campaigns", label: "Campaigns", icon: Flag },
  { path: "/reports", label: "Reports", icon: FileText },
  { path: "/validation", label: "Validation", icon: ClipboardCheck },
  { path: "/interventions", label: "Interventions", icon: FlaskConical },
  { path: "/tasks", label: "Tasks", icon: ListTodo },
  { path: "/settings", label: "Settings", icon: Settings },
];

/**
 * Same-question routes merged into one sidebar entry (spec 037). The first
 * member is the entry's target; every member stays a real URL with the tab
 * bar rendered on each page. Paths must exist in PROJECT_SECTIONS — the
 * nav-structure test enforces it.
 */
export interface TabSet {
  key: string;
  /** Sidebar label for the merged entry (null = keep the lead section's). */
  label: string | null;
  paths: string[];
}

export const TAB_SETS: TabSet[] = [
  { key: "measure", label: null, paths: ["/runs", "/review"] },
  { key: "findings", label: "Findings", paths: ["/gaps", "/accuracy"] },
  { key: "work", label: "Work", paths: ["/tasks", "/campaigns", "/interventions"] },
  { key: "reports", label: null, paths: ["/reports", "/validation"] },
];

/**
 * The sidebar's visible structure (spec 037): the reading order that used
 * to live only in the comment above, made visible. Entries name either a
 * bare section path or a tab-set lead path; the sidebar highlights a
 * tab-set entry for any of its members.
 */
export interface NavGroup {
  label: string | null;
  paths: string[];
}

export const PROJECT_NAV_GROUPS: NavGroup[] = [
  { label: "Overview", paths: ["", "/plan", "/knowledge"] },
  { label: "Measure", paths: ["/prompts", "/runs"] },
  { label: "Findings", paths: ["/gaps", "/competitors"] },
  { label: "Act", paths: ["/content", "/tasks", "/reports"] },
  { label: null, paths: ["/settings"] },
];

export function tabSetFor(path: string): TabSet | undefined {
  return TAB_SETS.find((set) => set.paths.includes(path));
}

export function sectionFor(path: string): ProjectSection | undefined {
  return PROJECT_SECTIONS.find((section) => section.path === path);
}
