/**
 * Derive a short, filesystem- and git-ref-safe slug from a free-text objective.
 * Used for branch names (`autoralph/<slug>`) and run ids.
 */
export function slugify(text: string, maxLength = 48): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "run";
}

/** Append a short time-based suffix to keep run ids unique within a repo. */
export function makeRunId(objective: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");
  return `${slugify(objective, 32)}-${stamp}`;
}
