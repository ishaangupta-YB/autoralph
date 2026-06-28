import type { IterationStatus } from "./board";

export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Thin per-run accent bar colours — a cobalt-leaning, calm palette. */
export const RUN_COLORS = [
  "oklch(58% 0.20 256)",
  "oklch(60% 0.16 296)",
  "oklch(64% 0.16 150)",
  "oklch(70% 0.15 230)",
  "oklch(66% 0.14 196)",
  "oklch(62% 0.18 330)",
] as const;

export function runColor(index: number): string {
  return RUN_COLORS[index % RUN_COLORS.length]!;
}

export interface ColumnDef {
  key: string;
  title: string;
  statuses: IterationStatus[];
}

export const COLUMNS: ColumnDef[] = [
  { key: "active", title: "In Progress", statuses: ["queued", "running"] },
  { key: "committed", title: "Committed", statuses: ["committed"] },
  { key: "discarded", title: "Discarded", statuses: ["discarded"] },
  { key: "blocked", title: "Repair / Aborted", statuses: ["repair", "aborted"] },
];
