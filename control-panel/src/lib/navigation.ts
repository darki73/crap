import {
  Activity,
  Boxes,
  Cable,
  Gauge,
  KeyRound,
  LayoutDashboard,
  NotebookTabs,
  Puzzle,
  Settings2,
  Stethoscope,
  Terminal,
  Compass,
} from "lucide-react";

export const navigation = [
  {
    id: "overview",
    label: "Overview",
    group: "Workspace",
    icon: LayoutDashboard,
    description: "Health and connection flow",
  },
  {
    id: "setup",
    label: "Setup & Integrations",
    group: "Workspace",
    icon: Compass,
    description: "Your setup guide, remote access and notifications",
  },
  {
    id: "providers",
    label: "Accounts & Providers",
    group: "Gateway",
    icon: Cable,
    description: "Connect accounts and upstream providers",
  },
  {
    id: "models",
    label: "Models",
    group: "Gateway",
    icon: Boxes,
    description: "Available models and capabilities",
  },
  {
    id: "keys",
    label: "Client API Keys",
    group: "Gateway",
    icon: KeyRound,
    description: "Access keys for your apps and tools",
  },
  {
    id: "affinity",
    label: "Routing & Affinity",
    group: "Gateway",
    icon: Activity,
    description: "Account selection, headroom and routing decisions",
  },
  {
    id: "usage",
    label: "Quota & Limits",
    group: "Monitor",
    icon: Gauge,
    description: "Subscription windows and remaining allowance",
  },
  {
    id: "ledger",
    label: "Token Ledger",
    group: "Monitor",
    icon: NotebookTabs,
    description: "Recorded tokens, cache usage and cost estimates",
  },
  {
    id: "logs",
    label: "Logs",
    group: "Monitor",
    icon: Terminal,
    description: "Proxy events and request errors",
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    group: "Monitor",
    icon: Stethoscope,
    description: "Connection checks and test requests",
  },
  {
    id: "configuration",
    label: "Proxy Configuration",
    group: "System",
    icon: Settings2,
    description: "Proxy engine settings, logging and server options",
  },
  {
    id: "plugins",
    label: "Plugins",
    group: "System",
    icon: Puzzle,
    description: "Installed extensions and their configuration",
  },
] as const;

export type Page = (typeof navigation)[number]["id"];
export const navigationGroups = [
  "Workspace",
  "Gateway",
  "Monitor",
  "System",
] as const;
export function pageFromHash(hash: string): Page {
  const value = hash.replace(/^#/, "");
  if (value === "settings") return "configuration";
  return navigation.some((item) => item.id === value)
    ? (value as Page)
    : "overview";
}
