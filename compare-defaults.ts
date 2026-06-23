export const DEFAULT_COMPARE_REVIEWER_TASK = [
	"Review the worker variants and produce findings only.",
	"Required output:",
	"1. Summarize concrete strengths with patch/diff evidence, including worktree change summaries when present.",
	"2. Call out concrete correctness risks and regression risks.",
	"3. Extract cherry-pick ideas from non-winning variants.",
	"4. Do not rank variants or select a winner.",
	"5. Do not include manual apply commands.",
].join("\n");

export const DEFAULT_COMPARE_FINAL_APPLIER_TASK = [
	"Apply the final implementation directly in the current repo.",
	"Required output:",
	"1. Pick the best single variant or synthesize/cherry-pick across variants.",
	"2. Apply changes directly on the current branch.",
	"3. Keep edits minimal and focused on the implementation task.",
	"4. Run obvious relevant verification when practical.",
	"5. Report changed files and verification commands run.",
].join("\n");
