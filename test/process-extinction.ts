import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

export async function assertProcessExtinct(pid: number, message = `process ${pid} survived cancellation`): Promise<void> {
	const deadline = Date.now() + 2_000;
	let operationallyAlive = true;
	while (operationallyAlive && Date.now() < deadline) {
		try {
			process.kill(pid, 0);
			const state = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 500 }).trim();
			operationallyAlive = state.length > 0 && !state.startsWith("Z");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH" || (error as { status?: number }).status === 1) operationallyAlive = false;
			else throw error;
		}
		if (operationallyAlive) await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(operationallyAlive, false, message);
}
