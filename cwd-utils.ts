import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function expandCwdPath(raw: string): string | undefined {
	const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
	return isAbsolute(expanded) ? expanded : undefined;
}
