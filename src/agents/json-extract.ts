/**
 * Recover a JSON object from an agent's final message.
 *
 * Agents are asked to reply with JSON only, but some prepend prose or wrap the
 * payload in markdown fences. These helpers extract the structured object in
 * those cases without changing behaviour for the well-formed pure-JSON path.
 */

export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const withoutOpen = trimmed.replace(/^```(?:json)?\s*\n?/, "");
  return withoutOpen.replace(/\n?```\s*$/, "").trim();
}

/**
 * Walk forward from `start` (which must be `{`) and return the first balanced
 * JSON object, tracking string and escape state so braces inside strings do
 * not affect depth. Returns null when no balanced, parseable object is found.
 */
export function extractBalancedObject(
  text: string,
  start: number,
): string | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Find a balanced JSON object inside `text`, preferring the rightmost one since
 * agents end their message with the structured answer.
 */
export function extractLastJsonObject(
  text: string,
  accepts?: (value: unknown) => boolean,
): string | null {
  let cursor = text.lastIndexOf("{");
  while (cursor >= 0) {
    const candidate = extractBalancedObject(text, cursor);
    if (candidate !== null) {
      if (!accepts) return candidate;
      try {
        if (accepts(JSON.parse(candidate))) return candidate;
      } catch {
        // Keep scanning earlier objects.
      }
    }
    cursor = text.lastIndexOf("{", cursor - 1);
  }
  return null;
}

export function parseAgentJson(
  text: string,
  accepts?: (value: unknown) => boolean,
): unknown | null {
  const cleaned = stripJsonFences(text);
  if (!cleaned) return null;

  try {
    const parsed = JSON.parse(cleaned);
    if (!accepts || accepts(parsed)) return parsed;
  } catch {
    // Fall through to balanced-object extraction.
  }

  const extracted = extractLastJsonObject(cleaned, accepts);
  if (!extracted) return null;
  try {
    return JSON.parse(extracted);
  } catch {
    return null;
  }
}
