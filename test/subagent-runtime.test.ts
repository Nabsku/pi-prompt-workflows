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

test("ensureSubagentRuntime discovers Pi-managed extension and git layouts", async () => {
	await withTempDir(async (root) => {
		const extensionProject = join(root, "extension-project");
		const extensionRoot = join(extensionProject, ".pi", "extensions", "subagent");
		writeRuntime(extensionRoot);
		assert.equal((await ensureSubagentRuntime(extensionProject, { globalNodeModules: [] })).root, extensionRoot);

		const gitProject = join(root, "git-project");
		const gitRoot = join(gitProject, ".pi", "git", "github.com", "owner", "pi-subagents");
		writeNestedPackageRuntime(gitRoot);
		assert.equal((await ensureSubagentRuntime(gitProject, { globalNodeModules: [] })).root, join(gitRoot, "src", "agents"));
	});
});

test("ensureSubagentRuntime prefers local layouts before injected global installs", async () => {
	await withTempDir(async (root) => {
		const project = join(root, "project");
		const localRoot = join(project, ".pi", "extensions", "subagent");
		const globalModules = join(root, "global", "node_modules");
		writeRuntime(localRoot);
		writeRuntime(join(globalModules, "pi-subagents"));
		assert.equal((await ensureSubagentRuntime(project, { globalNodeModules: [globalModules] })).root, localRoot);
	});
});

test("ensureSubagentRuntime discovers injected global node_modules without shelling out", async () => {
	await withTempDir(async (root) => {
		const globalModules = join(root, "global", "node_modules");
		const runtimeRoot = join(globalModules, "pi-subagents", "src", "agents");
		writeRuntime(runtimeRoot);
		assert.equal((await ensureSubagentRuntime(join(root, "project"), { globalNodeModules: [globalModules] })).root, runtimeRoot);
	});
});

test("managed git discovery is fail-safe for missing paths and bounded against deep layouts", async () => {
	await withTempDir(async (root) => {
		const project = join(root, "project");
		const tooDeep = join(project, ".pi", "git", "1", "2", "3", "4", "5", "6", "7", "pi-subagents");
		writeRuntime(tooDeep);
		await assert.rejects(() => ensureSubagentRuntime(project, { globalNodeModules: [] }), /Checked runtime directories/i);
	});
});

test("ensureSubagentRuntime does not discover legacy project .pi/agent extension paths", async () => {
	await withTempDir(async (root) => {
		const project = join(root, "project");
		writeRuntime(join(project, ".pi", "agent", "extensions", "subagent"));

		await assert.rejects(
			() => ensureSubagentRuntime(project, { globalNodeModules: [] }),
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
