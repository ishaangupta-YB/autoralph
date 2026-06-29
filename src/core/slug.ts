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

/**
 * Append a time-based suffix plus a short random token to keep run ids unique.
 * The timestamp keeps ids sortable; the random token guards against collisions
 * when several runs start within the same second (e.g. parallel launches).
 */
export function makeRunId(objective: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${slugify(objective, 32)}-${stamp}-${rand}`;
}
