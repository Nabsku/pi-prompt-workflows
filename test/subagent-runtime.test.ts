import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSubagentRuntime, resolveDelegatedAgent } from "../subagent-runtime.js";

async function withTempDir(run: (root: string) => Promise<void> | void) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-subagent-runtime-"));
	const previousHome = process.env.HOME;
	const previousRuntime = process.env.PI_SUBAGENT_RUNTIME_ROOT;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = root;
	delete process.env.PI_SUBAGENT_RUNTIME_ROOT;
	delete process.env.PI_CODING_AGENT_DIR;
	try {
		await run(root);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousRuntime === undefined) delete process.env.PI_SUBAGENT_RUNTIME_ROOT;
		else process.env.PI_SUBAGENT_RUNTIME_ROOT = previousRuntime;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
}

function writeRuntime(root: string) {
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "agents.js"),
		"export function discoverAgents(){ return { agents: [{ name: 'delegate' }, { name: 'reviewer' }] }; }",
	);
}

function writeNestedPackageRuntime(packageRoot: string) {
	writeRuntime(join(packageRoot, "src", "agents"));
}

test("ensureSubagentRuntime loads discoverAgents from configured runtime root", async () => {
	await withTempDir(async (root) => {
		const runtimeRoot = join(root, "custom-runtime");
		writeRuntime(runtimeRoot);
		process.env.PI_SUBAGENT_RUNTIME_ROOT = runtimeRoot;

		const runtime = await ensureSubagentRuntime(root);
		assert.equal(resolveDelegatedAgent(runtime, root, "delegate"), "delegate");
	});
});

test("ensureSubagentRuntime fails when configured runtime root is missing", async () => {
	await withTempDir(async (root) => {
		process.env.PI_SUBAGENT_RUNTIME_ROOT = join(root, "missing-runtime");

		await assert.rejects(
			() => ensureSubagentRuntime(root),
			/pi-subagents[\s\S]*PI_SUBAGENT_RUNTIME_ROOT/i,
		);
	});
});

test("ensureSubagentRuntime discovers project-local pi-subagents npm installs", async () => {
	await withTempDir(async (root) => {
		const project = join(root, "project");
		const runtimeRoot = join(project, ".pi", "npm", "node_modules", "pi-subagents");
		writeRuntime(runtimeRoot);

		const runtime = await ensureSubagentRuntime(project);
		assert.equal(runtime.root, runtimeRoot);
		assert.equal(resolveDelegatedAgent(runtime, project, "reviewer"), "reviewer");
	});
});

test("ensureSubagentRuntime discovers nested pi-subagents npm runtime layout", async () => {
	await withTempDir(async (root) => {
		const project = join(root, "project");
		const packageRoot = join(project, ".pi", "npm", "node_modules", "pi-subagents");
		const runtimeRoot = join(packageRoot, "src", "agents");
		writeNestedPackageRuntime(packageRoot);

		const runtime = await ensureSubagentRuntime(project);
		assert.equal(runtime.root, runtimeRoot);
		assert.equal(resolveDelegatedAgent(runtime, project, "delegate"), "delegate");
	});
});

test("ensureSubagentRuntime accepts PI_SUBAGENT_RUNTIME_ROOT pointing at pi-subagents package root", async () => {
	await withTempDir(async (root) => {
		const packageRoot = join(root, "pi-subagents");
		const runtimeRoot = join(packageRoot, "src", "agents");
		writeNestedPackageRuntime(packageRoot);
		process.env.PI_SUBAGENT_RUNTIME_ROOT = packageRoot;

		const runtime = await ensureSubagentRuntime(root);
		assert.equal(runtime.root, runtimeRoot);
		assert.equal(resolveDelegatedAgent(runtime, root, "reviewer"), "reviewer");
	});
});

test("ensureSubagentRuntime discovers PI_CODING_AGENT_DIR npm/node_modules pi-subagents runtime", async () => {
	await withTempDir(async (root) => {
		const agentDir = join(root, "custom-agent-dir");
		const packageRoot = join(agentDir, "npm", "node_modules", "pi-subagents");
		const runtimeRoot = join(packageRoot, "src", "agents");
		writeNestedPackageRuntime(packageRoot);
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const runtime = await ensureSubagentRuntime(join(root, "project"));
		assert.equal(runtime.root, runtimeRoot);
		assert.equal(resolveDelegatedAgent(runtime, root, "delegate"), "delegate");
	});
});

test("ensureSubagentRuntime expands tilde in PI_CODING_AGENT_DIR", async () => {
	await withTempDir(async (root) => {
		const packageRoot = join(root, "agent-dir", "node_modules", "pi-subagents");
		const runtimeRoot = join(packageRoot, "src", "agents");
		writeNestedPackageRuntime(packageRoot);
		process.env.PI_CODING_AGENT_DIR = "~/agent-dir";

		const runtime = await ensureSubagentRuntime(join(root, "project"));
		assert.equal(runtime.root, runtimeRoot);
		assert.equal(resolveDelegatedAgent(runtime, root, "reviewer"), "reviewer");
	});
});

test("ensureSubagentRuntime discovers ancestor project pi-subagents runtime from nested cwd", async () => {
	await withTempDir(async (root) => {
		const project = join(root, "project");
		const nestedCwd = join(project, "packages", "app", "src");
		mkdirSync(nestedCwd, { recursive: true });
		const packageRoot = join(project, ".pi", "npm", "node_modules", "pi-subagents");
		const runtimeRoot = join(packageRoot, "src", "agents");
		writeNestedPackageRuntime(packageRoot);

		const runtime = await ensureSubagentRuntime(nestedCwd);
		assert.equal(runtime.root, runtimeRoot);
		assert.equal(resolveDelegatedAgent(runtime, nestedCwd, "delegate"), "delegate");
	});
});

test("PI_SUBAGENT_RUNTIME_ROOT env override replaces cached automatic runtime", async () => {
	await withTempDir(async (root) => {
		const project = join(root, "project");
		const automaticRoot = join(project, ".pi", "npm", "node_modules", "pi-subagents");
		writeRuntime(automaticRoot);

		const automaticRuntime = await ensureSubagentRuntime(project);
		assert.equal(automaticRuntime.root, automaticRoot);

		const overrideRoot = join(root, "override-runtime");
		writeRuntime(overrideRoot);
		process.env.PI_SUBAGENT_RUNTIME_ROOT = overrideRoot;

		const overrideRuntime = await ensureSubagentRuntime(project);
		assert.equal(overrideRuntime.root, overrideRoot);
		assert.equal(resolveDelegatedAgent(overrideRuntime, project, "reviewer"), "reviewer");
	});
});

test("ensureSubagentRuntime does not discover legacy subagent extension paths", async () => {
	await withTempDir(async (root) => {
		const project = join(root, "project");
		writeRuntime(join(project, ".pi", "agent", "extensions", "subagent"));
		writeRuntime(join(root, ".pi", "agent", "extensions", "subagent"));

		await assert.rejects(
			() => ensureSubagentRuntime(project),
			/pi-subagents[\s\S]*PI_SUBAGENT_RUNTIME_ROOT/i,
		);
	});
});

test("ensureSubagentRuntime reports checked runtime directories when discovery fails", async () => {
	await withTempDir(async (root) => {
		const project = join(root, "project");

		await assert.rejects(
			() => ensureSubagentRuntime(project),
			(error) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /pi-subagents[\s\S]*PI_SUBAGENT_RUNTIME_ROOT/i);
				assert.match(error.message, /Checked runtime directories:/i);
				assert.match(error.message, /src\/agents/i);
				return true;
			},
		);
	});
});

test("ensureSubagentRuntime reports invalid PI_SUBAGENT_RUNTIME_ROOT as env-only discovery", async () => {
	await withTempDir(async (root) => {
		process.env.PI_SUBAGENT_RUNTIME_ROOT = join(root, "missing-runtime");

		await assert.rejects(
			() => ensureSubagentRuntime(root),
			(error) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /PI_SUBAGENT_RUNTIME_ROOT/i);
				assert.match(error.message, /environment override/i);
				assert.match(error.message, /missing-runtime/i);
				return true;
			},
		);
	});
});
