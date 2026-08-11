import test from "node:test";
import assert from "node:assert/strict";
import {
	clearDelegatedLiveState,
	getDelegatedLiveState,
	updateDelegatedLiveState,
} from "../subagent-runtime.js";

test("delegated live-state snapshots are detached from mutable internal state", () => {
	const requestId = "detached-live-state";
	clearDelegatedLiveState(requestId);
	try {
		updateDelegatedLiveState(requestId, {
			status: "running",
			recentOutput: ["first"],
			recentTools: [{ tool: "read", args: "README.md" }],
		});

		const first = getDelegatedLiveState(requestId);
		assert.ok(first);
		first.recentOutput.push("mutated");
		first.recentTools[0]!.args = "mutated";

		const second = getDelegatedLiveState(requestId);
		assert.deepEqual(second?.recentOutput, ["first"]);
		assert.deepEqual(second?.recentTools, [{ tool: "read", args: "README.md" }]);
	} finally {
		clearDelegatedLiveState(requestId);
	}
});
