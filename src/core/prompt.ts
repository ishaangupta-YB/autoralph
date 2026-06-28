export interface IterationPromptParams {
  iteration: number;
  runId: string;
  objective: string;
  stopWhen?: string;
  /** Repair instructions injected after a commit failed in a prior iteration. */
  commitRepair?: string;
}

const NOTES_RELATIVE_PATH = (runId: string) =>
  `.autoralph/runs/${runId}/notes.md`;

/**
 * Build the per-iteration prompt. Each iteration is framed as a single
 * incremental step (not the whole objective) and is told to read the shared
 * notes file for prior context. The structured-output contract is described in
 * prose here; the JSON schema is enforced separately by the agent integration.
 */
export function buildIterationPrompt(params: IterationPromptParams): string {
  const outputFields = [
    "- success: whether you made a meaningful contribution toward the objective. false discards this iteration's changes. A no-op iteration (no file changes AND no new learnings worth recording) is not a success: set success=false so the run can halt instead of spinning.",
    "- summary: a concise one-sentence summary of what this iteration accomplished.",
    "- key_changes_made: an array describing key changes, grouped by logical unit of work (not by file). Describe outcomes, not activities.",
    "- key_learnings: an array of new, surprising learnings not already captured in notes that would help future iterations.",
  ];

  if (params.stopWhen !== undefined) {
    outputFields.push(
      "- should_fully_stop: set true ONLY when the stop condition below is fully met and the whole loop should end. Otherwise false.",
    );
  }

  const stopSection =
    params.stopWhen !== undefined
      ? `\n\n## Stop Condition\n\nThe loop ends when: ${params.stopWhen}\nIf this is fully satisfied after this iteration, set should_fully_stop=true.`
      : "";

  const repairSection = params.commitRepair
    ? `\n\n## Commit Repair Required\n\n${params.commitRepair}`
    : "";

  return `You are working autonomously toward the objective below.
This is iteration ${params.iteration}. Each iteration makes one incremental step, not the whole objective.

## Instructions

1. Read ${NOTES_RELATIVE_PATH(params.runId)} first to understand prior iterations. Do NOT modify notes.md; autoralph maintains it.
2. Pick the next smallest individually verifiable unit of work and treat that as this iteration's scope.
3. If an attempt does not move the objective forward, record the learning and set success=false rather than pivoting endlessly.
4. If you change code, run available build/test/lint steps to validate. Do NOT create git commits; autoralph commits successful iterations automatically.
5. Stop any background processes you start (servers, watchers) before finishing.
6. Reply with the final JSON only after the work is complete and validated.

## Output (return a single JSON object)

${outputFields.join("\n")}${stopSection}${repairSection}

## Objective

${params.objective}`;
}
