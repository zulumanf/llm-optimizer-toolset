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
  { path: "/reports", label: "Reports", icon: FileText },
  { path: "/validation", label: "Validation", icon: ClipboardCheck },
  { path: "/interventions", label: "Interventions", icon: FlaskConical },
  { path: "/tasks", label: "Tasks", icon: ListTodo },
  { path: "/settings", label: "Settings", icon: Settings },
];
