/** Git subprocess environment that cannot inherit repository-shaping GIT_* overrides. */
export function sanitizedGitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) if (!key.startsWith("GIT_")) env[key] = value;
	return {
		...env,
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
		GIT_PAGER: "cat",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_ATTR_NOSYSTEM: "1",
		GCM_INTERACTIVE: "Never",
		PAGER: "cat",
	};
}
