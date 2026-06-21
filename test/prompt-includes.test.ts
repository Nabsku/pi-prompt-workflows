import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectPromptIncludeGraphs, extractPromptInlineIncludes, hasPromptIncludesPlaceholder, renderPromptIncludes } from "../prompt-includes.js";
import type { RenderPromptIncludesResult } from "../prompt-includes.js";
import type { PromptSourceRecord } from "../prompt-loader.js";

interface IncludeFixture {
	home: string;
	cwd: string;
	promptRoot: string;
	promptDir: string;
	promptFilePath: string;
	projectLibrary: string;
	userLibrary: string;
	globalPartials: string;
	projectPartials: string;
}

function withFixture(run: (fixture: IncludeFixture) => void) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-includes-"));
	try {
		const home = join(root, "home");
		const cwd = join(root, "project");
		const promptRoot = join(cwd, ".pi", "prompts");
		const promptDir = join(promptRoot, "nested");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		const userLibrary = join(home, ".pi", "agent", "prompt-library");
		const globalPartials = join(home, ".pi", "agent", "prompt-partials");
		const projectPartials = join(cwd, ".pi", "prompt-partials");
		const promptFilePath = join(promptDir, "prompt.md");

		mkdirSync(promptDir, { recursive: true });
		mkdirSync(projectLibrary, { recursive: true });
		mkdirSync(userLibrary, { recursive: true });
		mkdirSync(globalPartials, { recursive: true });
		mkdirSync(projectPartials, { recursive: true });
		writeFileSync(promptFilePath, "---\nmodel: test\n---\nbody");

		run({ home, cwd, promptRoot, promptDir, promptFilePath, projectLibrary, userLibrary, globalPartials, projectPartials });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function render(
	fixture: IncludeFixture,
	content: string,
	includes?: string[],
	options: { debugBoundaries?: boolean; promptFilePath?: string; promptRoot?: string; rootKind?: "prompts" | "prompt-library" } = {},
): RenderPromptIncludesResult {
	return renderPromptIncludes({
		promptName: "prompt",
		content,
		includes,
		promptFilePath: options.promptFilePath ?? fixture.promptFilePath,
		promptRoot: options.promptRoot ?? fixture.promptRoot,
		cwd: fixture.cwd,
		source: "project",
		rootKind: options.rootKind,
		homeDir: fixture.home,
		debugBoundaries: options.debugBoundaries,
	});
}

function assertOk(result: RenderPromptIncludesResult): asserts result is Extract<RenderPromptIncludesResult, { ok: true }> {
	if (!result.ok) {
		assert.fail(`expected render to succeed, diagnostics:\n${result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")}`);
	}
}

function assertFail(result: RenderPromptIncludesResult): asserts result is Extract<RenderPromptIncludesResult, { ok: false }> {
	if (result.ok) {
		assert.fail(`expected render to fail, content:\n${result.content}`);
	}
}

function sourceRecord(fixture: IncludeFixture, overrides: Partial<PromptSourceRecord> = {}): PromptSourceRecord {
	return {
		promptName: "prompt",
		filePath: fixture.promptFilePath,
		promptRoot: fixture.promptRoot,
		cwd: fixture.cwd,
		source: "project",
		rootKind: "prompts",
		promptCapable: true,
		rawBody: "body",
		hasInlineIncludes: false,
		hasIncludesPlaceholder: false,
		isChainWrapper: false,
		...overrides,
	};
}

function collectSingleGraph(fixture: IncludeFixture, record: PromptSourceRecord) {
	const result = collectPromptIncludeGraphs({ records: [record], homeDir: fixture.home });
	assert.equal(result.graphs.length, 1);
	return result.graphs[0];
}

test("frontmatter includes prepend in deterministic order when no placeholder exists", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectPartials, "one.md"), "one");
		writeFileSync(join(fixture.projectPartials, "two.md"), "two");

		const result = render(fixture, "body", ["two.md", "one.md"]);

		assertOk(result);
		assert.equal(result.content, "two\n\none\n\nbody");
		assert.doesNotMatch(result.content, /BEGIN include|END include/);
	});
});

test("<includes /> controls placement of the frontmatter include group", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectPartials, "first.md"), "first");
		writeFileSync(join(fixture.projectPartials, "second.md"), "second");

		const result = render(fixture, "before\n<includes />\nafter", ["first.md", "second.md"]);

		assertOk(result);
		assert.equal(result.content, "before\nfirst\n\nsecond\nafter");
	});
});

test("<includes /> inserts frontmatter includes verbatim", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectPartials, "shell.md"), "echo $$ && printf '$& $` $1'");

		const result = render(fixture, "before\n<includes />\nafter", ["shell.md"]);

		assertOk(result);
		assert.equal(result.content, "before\necho $$ && printf '$& $` $1'\nafter");
	});
});

test("repeated <includes /> placeholders do not duplicate identical include diagnostics", () => {
	withFixture((fixture) => {
		const result = render(fixture, "<includes />\n<includes />", ["missing.md"]);

		assertFail(result);
		const notFoundDiagnostics = result.diagnostics.filter((diagnostic) => diagnostic.code === "include-not-found");
		assert.equal(notFoundDiagnostics.length, 1);
		assert.equal(new Set(result.diagnostics.map((diagnostic) => diagnostic.key)).size, result.diagnostics.length);
	});
});

test("render include graph follows rendered output order around <includes />", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectPartials, "a.md"), "A");
		writeFileSync(join(fixture.projectPartials, "front.md"), "F");
		writeFileSync(join(fixture.projectPartials, "b.md"), "B");

		const result = render(fixture, '<include file="a.md" />\n<includes />\n<include file="b.md" />', ["front.md"]);

		assertOk(result);
		assert.equal(result.content, "A\nF\nB");
		assert.deepEqual(result.includeGraph.edges.map((edge) => edge.includePath), ["a.md", "front.md", "b.md"]);
		assert.deepEqual(result.includeGraph.edges.map((edge) => edge.kind), ["inline", "frontmatter", "inline"]);
		assert.equal(result.includeGraph.root.promptName, "prompt");
	});
});

test("<includes /> without frontmatter includes fails with a diagnostic", () => {
	withFixture((fixture) => {
		const result = render(fixture, "before <includes /> after");

		assertFail(result);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-placeholder-without-includes"), true);
		assert.match(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /frontmatter.*include/i);
	});
});

test("inline <include file=... /> controls exact placement for one-off includes", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.promptDir, "one-off.md"), "inserted");

		const result = render(fixture, "alpha <include file=\"one-off.md\" /> omega");

		assertOk(result);
		assert.equal(result.content, "alpha inserted omega");
	});
});

test("extractPromptInlineIncludes returns inline include paths in source order", () => {
	assert.deepEqual(extractPromptInlineIncludes('a <include file="one.md" /> b <include file="two.md" />'), ["one.md", "two.md"]);
});

test("extractPromptInlineIncludes ignores non-include lookalikes", () => {
	assert.deepEqual(extractPromptInlineIncludes('<include-file file="no.md" /> <include file="yes.md" />'), ["yes.md"]);
});

test("hasPromptIncludesPlaceholder detects includes placeholder", () => {
	assert.equal(hasPromptIncludesPlaceholder("before <includes /> after"), true);
	assert.equal(hasPromptIncludesPlaceholder('before <include file="x.md" /> after'), false);
});

test("nested inline includes work", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectPartials, "outer.md"), "outer-start\n<include file=\"inner.md\" />\nouter-end");
		writeFileSync(join(fixture.projectPartials, "inner.md"), "inner");

		const result = render(fixture, "body", ["outer.md"]);

		assertOk(result);
		assert.equal(result.content, "outer-start\ninner\nouter-end\n\nbody");
	});
});

test("nested inline includes in subdirectory partials resolve relative to the current partial", () => {
	withFixture((fixture) => {
		const sharedPartials = join(fixture.projectPartials, "shared");
		mkdirSync(sharedPartials, { recursive: true });
		writeFileSync(join(sharedPartials, "outer.md"), "outer-start\n<include file=\"inner.md\" />\nouter-end");
		writeFileSync(join(sharedPartials, "inner.md"), "inner");

		const result = render(fixture, "body", ["shared/outer.md"]);

		assertOk(result);
		assert.equal(result.content, "outer-start\ninner\nouter-end\n\nbody");
	});
});

test("nested prompt-library symlink includes may target files inside the owner root", () => {
	withFixture((fixture) => {
		const partials = join(fixture.projectLibrary, "partials");
		mkdirSync(partials, { recursive: true });
		writeFileSync(join(fixture.projectLibrary, "prompt.md"), "---\nmodel: test\ninclude: partials/outer.md\n---\nbody");
		writeFileSync(join(partials, "outer.md"), 'outer-start\n<include file="link.md" />\nouter-end');
		writeFileSync(join(fixture.projectLibrary, "shared.md"), "shared");
		symlinkSync("../shared.md", join(partials, "link.md"));

		const result = render(fixture, "body", ["partials/outer.md"], {
			promptFilePath: join(fixture.projectLibrary, "prompt.md"),
			promptRoot: fixture.projectLibrary,
			rootKind: "prompt-library",
		});

		assertOk(result);
		assert.equal(result.content, "outer-start\nshared\nouter-end\n\nbody");
	});
});

test("nested legacy partial includes fall back to the original prompt root after the current owner root", () => {
	withFixture((fixture) => {
		const sharedPromptRoot = join(fixture.promptRoot, "shared");
		mkdirSync(sharedPromptRoot, { recursive: true });
		writeFileSync(join(fixture.projectPartials, "outer.md"), "outer-start\n<include file=\"shared/root.md\" />\nouter-end");
		writeFileSync(join(sharedPromptRoot, "root.md"), "root-from-original-prompt-root");

		const result = render(fixture, "body", ["outer.md"]);

		assertOk(result);
		assert.equal(result.content, "outer-start\nroot-from-original-prompt-root\nouter-end\n\nbody");
	});
});

test("nested inline include diagnostics point at the partial containing the bad directive", () => {
	withFixture((fixture) => {
		const sharedPartials = join(fixture.projectPartials, "shared");
		const outerPath = join(sharedPartials, "outer.md");
		mkdirSync(sharedPartials, { recursive: true });
		writeFileSync(outerPath, "outer-start\n<include file=\"missing.md\" />\nouter-end");

		const result = render(fixture, "body", ["shared/outer.md"]);

		assertFail(result);
		const diagnostic = result.diagnostics.find((item) => item.code === "include-not-found");
		assert.ok(diagnostic);
		assert.equal(diagnostic.filePath, realpathSync(outerPath));
	});
});

test("cyclic nested includes fail with diagnostics", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectPartials, "a.md"), "a -> <include file=\"b.md\" />");
		writeFileSync(join(fixture.projectPartials, "b.md"), "b -> <include file=\"a.md\" />");

		const result = render(fixture, "body", ["a.md"]);

		assertFail(result);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-cycle"), true);
		assert.match(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /Cyclic prompt include detected/);
	});
});

test("deep acyclic nested includes fail with a diagnostic instead of overflowing the stack", () => {
	withFixture((fixture) => {
		const chainLength = 70;
		for (let index = 0; index < chainLength; index += 1) {
			const next = index + 1;
			writeFileSync(
				join(fixture.projectPartials, `chain-${index}.md`),
				next < chainLength ? `partial ${index}\n<include file=\"chain-${next}.md\" />` : `partial ${index}`,
			);
		}

		let result: RenderPromptIncludesResult | undefined;
		assert.doesNotThrow(() => {
			result = render(fixture, "body", ["chain-0.md"]);
		});

		assert.ok(result);
		assertFail(result);
		const diagnostic = result.diagnostics.find((item) => item.code === "include-depth-exceeded");
		assert.ok(diagnostic);
		assert.equal(diagnostic.filePath, realpathSync(join(fixture.projectPartials, "chain-63.md")));
	});
});

test("partial frontmatter is stripped and ignored", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectPartials, "ignored.md"), "should-not-render");
		writeFileSync(
			join(fixture.projectPartials, "partial.md"),
			[
				"---",
				"description: metadata only",
				"includes:",
				"  - ignored.md",
				"---",
				"partial body",
			].join("\n"),
		);

		const result = render(fixture, "body", ["partial.md"]);

		assertOk(result);
		assert.equal(result.content, "partial body\n\nbody");
	});
});

test("partial frontmatter preserves body whitespace", () => {
	withFixture((fixture) => {
		const body = "\n  leading spaces\ntrailing spaces  \n";
		writeFileSync(join(fixture.projectPartials, "whitespace.md"), `---\ndescription: metadata only\n---\n${body}`);

		const result = render(fixture, "", ["whitespace.md"]);

		assertOk(result);
		assert.equal(result.content, body);
	});
});

test("partial frontmatter preserves CRLF body line endings", () => {
	withFixture((fixture) => {
		const body = "first\r\nsecond\r\n";
		writeFileSync(join(fixture.projectPartials, "crlf.md"), `---\r\ndescription: metadata only\r\n---\r\n${body}`);

		const result = render(fixture, "", ["crlf.md"]);

		assertOk(result);
		assert.equal(result.content, body);
	});
});

test("resolution order checks prompt dir, prompt root, global partials, then project partials", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.promptDir, "shadow.md"), "prompt-dir");
		writeFileSync(join(fixture.promptRoot, "shadow.md"), "prompt-root-shadow");
		writeFileSync(join(fixture.globalPartials, "shadow.md"), "global-shadow");
		writeFileSync(join(fixture.projectPartials, "shadow.md"), "project-shadow");

		writeFileSync(join(fixture.promptRoot, "root-shadow.md"), "prompt-root");
		writeFileSync(join(fixture.globalPartials, "root-shadow.md"), "global-root-shadow");
		writeFileSync(join(fixture.projectPartials, "root-shadow.md"), "project-root-shadow");

		writeFileSync(join(fixture.globalPartials, "partials-shadow.md"), "global");
		writeFileSync(join(fixture.projectPartials, "partials-shadow.md"), "project-partials-shadow");

		writeFileSync(join(fixture.projectPartials, "project-only.md"), "project");

		const result = render(fixture, "", ["shadow.md", "root-shadow.md", "partials-shadow.md", "project-only.md"]);

		assertOk(result);
		assert.equal(result.content, "prompt-dir\n\nprompt-root\n\nglobal\n\nproject");
	});
});

test("missing includes fail with diagnostics", () => {
	withFixture((fixture) => {
		const result = render(fixture, "body", ["missing.md"]);

		assertFail(result);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found"), true);
	});
});

test("URL-scheme includes are rejected before reading literal local files", () => {
	withFixture((fixture) => {
		const urlIncludes = [
			{
				includePath: "https://example.com/remote.md",
				literalPathParts: ["https:", "example.com", "remote.md"],
			},
			{
				includePath: "http://example.com/remote.md",
				literalPathParts: ["http:", "example.com", "remote.md"],
			},
			{
				includePath: "file:///tmp/remote.md",
				literalPathParts: ["file:", "tmp", "remote.md"],
			},
		];

		for (const { includePath, literalPathParts } of urlIncludes) {
			const literalPath = join(fixture.projectPartials, ...literalPathParts);
			mkdirSync(dirname(literalPath), { recursive: true });
			writeFileSync(literalPath, `must not render ${includePath}`);

			const result = render(fixture, "body", [includePath]);

			assertFail(result);
			assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-url-disallowed"), true, includePath);
			assert.match(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /URL/i, includePath);
		}
	});
});

test("glob-looking includes are rejected before reading literal local files", () => {
	withFixture((fixture) => {
		const globIncludes = [
			{
				includePath: "*.md",
				literalPathParts: ["*.md"],
			},
			{
				includePath: "shared/**/*.md",
				literalPathParts: ["shared", "**", "*.md"],
			},
			{
				includePath: "shared/file?.md",
				literalPathParts: ["shared", "file?.md"],
			},
			{
				includePath: "shared/[abc].md",
				literalPathParts: ["shared", "[abc].md"],
			},
		];

		for (const { includePath, literalPathParts } of globIncludes) {
			const literalPath = join(fixture.projectPartials, ...literalPathParts);
			mkdirSync(dirname(literalPath), { recursive: true });
			writeFileSync(literalPath, `must not render ${includePath}`);

			const result = render(fixture, "body", [includePath]);

			assertFail(result);
			assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-glob-disallowed"), true, includePath);
			assert.match(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /glob/i, includePath);
		}
	});
});

test("non-markdown includes fail with diagnostics", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectPartials, "not-markdown.txt"), "nope");

		const result = render(fixture, "body", ["not-markdown.txt"]);

		assertFail(result);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-non-markdown"), true);
	});
});

test("../ escapes fail after path normalization", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.promptRoot, "outside-prompt-dir.md"), "outside");

		const result = render(fixture, "body", ["../outside-prompt-dir.md"]);

		assertFail(result);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-path-escaped"), true);
	});
});

test("symlink escapes fail after canonicalization", () => {
	withFixture((fixture) => {
		const outside = join(fixture.cwd, "outside.md");
		writeFileSync(outside, "outside");
		symlinkSync(outside, join(fixture.projectPartials, "link.md"));

		const result = render(fixture, "body", ["link.md"]);

		assertFail(result);
		const diagnostic = result.diagnostics.find((diagnostic) => diagnostic.code === "include-path-escaped");
		assert.ok(diagnostic);
		assert.equal(diagnostic.filePath, fixture.promptFilePath);
		assert.equal(diagnostic.message.includes(realpathSync(outside)), false);
	});
});

test("project prompt partials symlink root does not authorize outside files", () => {
	withFixture((fixture) => {
		const outsidePartials = join(fixture.cwd, "outside-project-partials");
		rmSync(fixture.projectPartials, { recursive: true, force: true });
		mkdirSync(outsidePartials, { recursive: true });
		writeFileSync(join(outsidePartials, "leak.md"), "project leak");
		symlinkSync(outsidePartials, fixture.projectPartials, "dir");

		const result = render(fixture, "body", ["leak.md"]);

		assertFail(result);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found" || diagnostic.code === "include-path-escaped"), true);
	});
});

test("global prompt partials symlink root does not authorize outside files", () => {
	withFixture((fixture) => {
		const outsidePartials = join(fixture.home, "outside-global-partials");
		rmSync(fixture.globalPartials, { recursive: true, force: true });
		mkdirSync(outsidePartials, { recursive: true });
		writeFileSync(join(outsidePartials, "leak.md"), "global leak");
		symlinkSync(outsidePartials, fixture.globalPartials, "dir");

		const relativeResult = render(fixture, "body", ["leak.md"]);
		assertFail(relativeResult);
		assert.equal(relativeResult.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found" || diagnostic.code === "include-path-escaped"), true);

		const homeResult = render(fixture, "body", ["~/.pi/agent/prompt-partials/leak.md"]);
		assertFail(homeResult);
		assert.equal(homeResult.diagnostics.some((diagnostic) => diagnostic.code === "include-path-escaped"), true);
	});
});

test("project prompt partials reject .pi ancestor symlink escapes", () => {
	withFixture((fixture) => {
		const outsidePi = join(fixture.cwd, "..", "outside-project-pi");
		const symlinkedPi = join(fixture.cwd, ".pi");
		rmSync(symlinkedPi, { recursive: true, force: true });
		mkdirSync(join(outsidePi, "prompt-partials"), { recursive: true });
		mkdirSync(join(outsidePi, "prompts", "nested"), { recursive: true });
		writeFileSync(join(outsidePi, "prompt-partials", "leak.md"), "project ancestor leak");
		writeFileSync(join(outsidePi, "prompts", "nested", "prompt.md"), "body");
		symlinkSync(outsidePi, symlinkedPi, "dir");

		const result = render(fixture, "body", ["leak.md"]);

		assertFail(result);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found" || diagnostic.code === "include-path-escaped"), true);
	});
});

test("global prompt partials reject agent ancestor symlink escapes", () => {
	withFixture((fixture) => {
		const outsideAgent = join(fixture.home, "..", "outside-global-agent");
		const symlinkedAgent = join(fixture.home, ".pi", "agent");
		rmSync(symlinkedAgent, { recursive: true, force: true });
		mkdirSync(join(outsideAgent, "prompt-partials"), { recursive: true });
		writeFileSync(join(outsideAgent, "prompt-partials", "leak.md"), "global ancestor leak");
		symlinkSync(outsideAgent, symlinkedAgent, "dir");

		const relativeResult = render(fixture, "body", ["leak.md"]);
		assertFail(relativeResult);
		assert.equal(relativeResult.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found" || diagnostic.code === "include-path-escaped"), true);

		const homeResult = render(fixture, "body", ["~/.pi/agent/prompt-partials/leak.md"]);
		assertFail(homeResult);
		assert.equal(homeResult.diagnostics.some((diagnostic) => diagnostic.code === "include-path-escaped"), true);
	});
});

test("non-tilde absolute include paths are rejected", () => {
	withFixture((fixture) => {
		const absoluteIncludePath = join(fixture.projectPartials, "safe.md");
		writeFileSync(absoluteIncludePath, "safe");

		const result = render(fixture, "body", [absoluteIncludePath]);

		assertFail(result);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-absolute-disallowed"), true);
	});
});

test("~/ include paths work only under allowed Pi roots", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.globalPartials, "home.md"), "home partial");
		writeFileSync(join(fixture.home, "private.md"), "private");

		const allowed = render(fixture, "body", ["~/.pi/agent/prompt-partials/home.md"]);
		assertOk(allowed);
		assert.equal(allowed.content, "home partial\n\nbody");

		const rejected = render(fixture, "body", ["~/private.md"]);
		assertFail(rejected);
		assert.equal(rejected.diagnostics.some((diagnostic) => diagnostic.code === "include-absolute-disallowed"), true);
	});
});

test("debug mode emits include boundary comments", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectPartials, "debug.md"), "debug body");

		const result = render(fixture, "body", ["debug.md"], { debugBoundaries: true });

		assertOk(result);
		assert.match(result.content, /<!-- BEGIN include: debug\.md -->/);
		assert.match(result.content, /debug body/);
		assert.match(result.content, /<!-- END include: debug\.md -->/);
	});
});

test("include graph records frontmatter includes in declaration order", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectPartials, "one.md"), "one");
		writeFileSync(join(fixture.projectPartials, "two.md"), "two");

		const graph = collectSingleGraph(fixture, sourceRecord(fixture, { includes: ["two.md", "one.md"] }));

		assert.deepEqual(graph.edges.map((edge) => [edge.kind, edge.includePath, edge.status]), [
			["frontmatter", "two.md", "ok"],
			["frontmatter", "one.md", "ok"],
		]);
		assert.deepEqual(graph.edges.map((edge) => edge.order), [0, 1]);
	});
});

test("include graph records inline includes in body order", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectPartials, "one.md"), "one");
		writeFileSync(join(fixture.projectPartials, "two.md"), "two");

		const graph = collectSingleGraph(
			fixture,
			sourceRecord(fixture, { rawBody: 'a <include file="one.md" /> b <include file="two.md" />', hasInlineIncludes: true }),
		);

		assert.deepEqual(graph.edges.map((edge) => [edge.kind, edge.includePath, edge.status]), [
			["inline", "one.md", "ok"],
			["inline", "two.md", "ok"],
		]);
	});
});

test("include graph records nested partial includes relative to current partial", () => {
	withFixture((fixture) => {
		const sharedPartials = join(fixture.projectPartials, "shared");
		mkdirSync(sharedPartials, { recursive: true });
		const outerPath = join(sharedPartials, "outer.md");
		const innerPath = join(sharedPartials, "inner.md");
		writeFileSync(outerPath, 'outer <include file="inner.md" />');
		writeFileSync(innerPath, "inner");

		const graph = collectSingleGraph(fixture, sourceRecord(fixture, { includes: ["shared/outer.md"] }));
		const nestedEdge = graph.edges.find((edge) => edge.includePath === "inner.md");

		assert.ok(nestedEdge);
		assert.equal(nestedEdge.fromNodeId, `file:${realpathSync(outerPath)}`);
		assert.equal(nestedEdge.toNodeId, `file:${realpathSync(innerPath)}`);
	});
});

test("include graph records repeated edges without duplicate traversal", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectPartials, "repeat.md"), 'repeat <include file="inner.md" />');
		writeFileSync(join(fixture.projectPartials, "inner.md"), "inner");

		const graph = collectSingleGraph(fixture, sourceRecord(fixture, { includes: ["repeat.md", "repeat.md"] }));

		assert.equal(graph.edges.filter((edge) => edge.includePath === "repeat.md").length, 2);
		assert.equal(graph.edges.filter((edge) => edge.includePath === "inner.md").length, 1);
	});
});

test("include graph represents missing include as failed edge and node", () => {
	withFixture((fixture) => {
		const graph = collectSingleGraph(fixture, sourceRecord(fixture, { includes: ["missing.md"] }));

		assert.equal(graph.edges.length, 1);
		assert.equal(graph.edges[0].status, "failed");
		assert.equal(graph.edges[0].diagnostics.some((diagnostic) => diagnostic.code === "include-not-found"), true);
		assert.equal(graph.nodes.some((node) => node.kind === "unresolved" && node.status === "failed"), true);
	});
});

test("include graph resolves prompt-library includes from the library root", () => {
	withFixture((fixture) => {
		const reviewPath = join(fixture.projectLibrary, "review.md");
		const rulesPath = join(fixture.projectLibrary, "partials", "rules.md");
		mkdirSync(dirname(rulesPath), { recursive: true });
		writeFileSync(reviewPath, "---\nmodel: claude-sonnet-4\ninclude: partials/rules.md\n---\nreview");
		writeFileSync(rulesPath, "rules");

		const graph = collectSingleGraph(
			fixture,
			sourceRecord(fixture, {
				promptName: "review",
				filePath: reviewPath,
				promptRoot: fixture.projectLibrary,
				rootKind: "prompt-library",
				rawBody: "review",
				includes: ["partials/rules.md"],
			}),
		);

		assert.equal(graph.edges.length, 1);
		assert.equal(graph.edges[0].includePath, "partials/rules.md");
		assert.equal(graph.edges[0].status, "ok");
		assert.equal(graph.nodes.some((node) => node.id === `file:${realpathSync(rulesPath)}` && node.status === "ok"), true);
	});
});

test("include graph represents cycle as failed edge", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectPartials, "a.md"), 'a <include file="b.md" />');
		writeFileSync(join(fixture.projectPartials, "b.md"), 'b <include file="a.md" />');

		const graph = collectSingleGraph(fixture, sourceRecord(fixture, { includes: ["a.md"] }));
		const cycleEdge = graph.edges.find((edge) => edge.includePath === "a.md" && edge.status === "failed");

		assert.ok(cycleEdge);
		assert.equal(cycleEdge.diagnostics.some((diagnostic) => diagnostic.code === "include-cycle"), true);
	});
});

test("include graph represents path escape as failed edge when resolver reports it", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.promptRoot, "outside-prompt-dir.md"), "outside");

		const graph = collectSingleGraph(fixture, sourceRecord(fixture, { includes: ["../outside-prompt-dir.md"] }));

		assert.equal(graph.edges.length, 1);
		assert.equal(graph.edges[0].status, "failed");
		assert.equal(graph.edges[0].diagnostics.some((diagnostic) => diagnostic.code === "include-path-escaped"), true);
	});
});

test("include graph records <includes /> without frontmatter includes as failed root diagnostic", () => {
	withFixture((fixture) => {
		const graph = collectSingleGraph(
			fixture,
			sourceRecord(fixture, { rawBody: "before <includes /> after", hasIncludesPlaceholder: true, includes: undefined }),
		);
		const rootNode = graph.nodes.find((node) => node.kind === "prompt");

		assert.equal(graph.diagnostics.some((diagnostic) => diagnostic.code === "include-placeholder-without-includes"), true);
		assert.ok(rootNode);
		assert.equal(rootNode.status, "failed");
		assert.equal(rootNode.diagnostics.some((diagnostic) => diagnostic.code === "include-placeholder-without-includes"), true);
	});
});

test("include graph records invalid chain include metadata as failed root diagnostic without body edges", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectPartials, "ignored.md"), "ignored");

		const graph = collectSingleGraph(
			fixture,
			sourceRecord(fixture, {
				rawBody: '<include file="ignored.md" />',
				isChainWrapper: true,
				includeMetadataInvalid: true,
				skippedReason: "invalid-includes-chain",
			}),
		);
		const rootNode = graph.nodes.find((node) => node.kind === "prompt");

		assert.deepEqual(graph.edges, []);
		assert.equal(graph.diagnostics.some((diagnostic) => diagnostic.code === "invalid-includes-chain"), true);
		assert.match(graph.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /include\/includes cannot be used on chain wrapper templates/);
		assert.ok(rootNode);
		assert.equal(rootNode.status, "failed");
		assert.equal(rootNode.diagnostics.some((diagnostic) => diagnostic.code === "invalid-includes-chain"), true);
	});
});

test("include graph ignores chain wrapper body include directives", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectPartials, "ignored.md"), "ignored");

		const graph = collectSingleGraph(
			fixture,
			sourceRecord(fixture, { rawBody: '<include file="ignored.md" />', hasInlineIncludes: false, isChainWrapper: true }),
		);

		assert.deepEqual(graph.edges, []);
		assert.equal(graph.nodes.length, 1);
	});
});


test("project prompts include project prompt-library partials by fallback", () => {
	withFixture((fixture) => {
		mkdirSync(join(fixture.projectLibrary, "partials"), { recursive: true });
		writeFileSync(join(fixture.projectLibrary, "partials", "rules.md"), "library rules");

		const result = render(fixture, "Review\n<includes />", ["partials/rules.md"]);

		assertOk(result);
		assert.equal(result.content, "Review\nlibrary rules");
	});
});

test("prompt-library prompts include sibling relative partials", () => {
	withFixture((fixture) => {
		const reviewPath = join(fixture.projectLibrary, "review.md");
		writeFileSync(reviewPath, "review");
		writeFileSync(join(fixture.projectLibrary, "rules.md"), "sibling rules");

		const result = render(fixture, "Review\n<includes />", ["rules.md"], {
			promptFilePath: reviewPath,
			promptRoot: fixture.projectLibrary,
			rootKind: "prompt-library",
		});

		assertOk(result);
		assert.equal(result.content, "Review\nsibling rules");
	});
});

test("prompt-library includes reject dot-prefixed path segments while legacy prompt-partials still allow them", () => {
	withFixture((fixture) => {
		mkdirSync(join(fixture.projectLibrary, ".hidden-dir"), { recursive: true });
		writeFileSync(join(fixture.projectLibrary, ".hidden.md"), "hidden file rules");
		writeFileSync(join(fixture.projectLibrary, ".hidden-dir", "rules.md"), "hidden dir rules");

		const hiddenFile = render(fixture, "body", [".hidden.md"]);
		assertFail(hiddenFile);
		assert.equal(hiddenFile.diagnostics.some((diagnostic) => diagnostic.code === "include-dotfile-disallowed"), true);

		const hiddenDir = render(fixture, "body", [".hidden-dir/rules.md"]);
		assertFail(hiddenDir);
		assert.equal(hiddenDir.diagnostics.some((diagnostic) => diagnostic.code === "include-dotfile-disallowed"), true);

		mkdirSync(join(fixture.projectPartials, ".legacy"), { recursive: true });
		writeFileSync(join(fixture.projectPartials, ".legacy", "rules.md"), "legacy hidden partial rules");
		const legacyPartial = render(fixture, "body", [".legacy/rules.md"]);
		assertOk(legacyPartial);
		assert.equal(legacyPartial.content, "legacy hidden partial rules\n\nbody");
	});
});

test("project prompts fall back to user prompt-library when project library has no match", () => {
	withFixture((fixture) => {
		mkdirSync(join(fixture.userLibrary, "partials"), { recursive: true });
		writeFileSync(join(fixture.userLibrary, "partials", "rules.md"), "user library rules");

		const result = render(fixture, "body", ["partials/rules.md"]);

		assertOk(result);
		assert.equal(result.content, "user library rules\n\nbody");
	});
});

test("home include paths under user prompt-library are allowed", () => {
	withFixture((fixture) => {
		mkdirSync(join(fixture.userLibrary, "partials"), { recursive: true });
		writeFileSync(join(fixture.userLibrary, "partials", "rules.md"), "home library rules");

		const result = render(fixture, "body", ["~/.pi/agent/prompt-library/partials/rules.md"]);

		assertOk(result);
		assert.equal(result.content, "home library rules\n\nbody");
	});
});

test("home include paths do not authorize through a symlinked user prompt-library current root", () => {
	withFixture((fixture) => {
		const outsideUserLibrary = join(fixture.home, "outside-user-library");
		rmSync(fixture.userLibrary, { recursive: true, force: true });
		mkdirSync(outsideUserLibrary, { recursive: true });
		writeFileSync(join(outsideUserLibrary, "review.md"), "review");
		writeFileSync(join(outsideUserLibrary, "leak.md"), "user leak");
		symlinkSync(outsideUserLibrary, fixture.userLibrary, "dir");

		const result = render(fixture, "body", ["~/.pi/agent/prompt-library/leak.md"], {
			promptFilePath: join(fixture.userLibrary, "review.md"),
			promptRoot: fixture.userLibrary,
			rootKind: "prompt-library",
		});

		assertFail(result);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-absolute-disallowed" || diagnostic.code === "include-path-escaped"), true);
	});
});

test("symlink escapes from prompt-library roots are rejected", () => {
	withFixture((fixture) => {
		const outsideProject = join(fixture.cwd, "project-leak.md");
		const outsideUser = join(fixture.home, "user-leak.md");
		writeFileSync(outsideProject, "project leak");
		writeFileSync(outsideUser, "user leak");
		symlinkSync(outsideProject, join(fixture.projectLibrary, "project-link.md"));
		symlinkSync(outsideUser, join(fixture.userLibrary, "user-link.md"));

		const projectResult = render(fixture, "body", ["project-link.md"]);
		assertFail(projectResult);
		assert.equal(projectResult.diagnostics.some((diagnostic) => diagnostic.code === "include-path-escaped"), true);

		const userResult = render(fixture, "body", ["user-link.md"]);
		assertFail(userResult);
		assert.equal(userResult.diagnostics.some((diagnostic) => diagnostic.code === "include-path-escaped"), true);
	});
});

test("prompt-library symlink roots do not authorize outside files", () => {
	withFixture((fixture) => {
		const outsideProjectLibrary = join(fixture.cwd, "outside-project-library");
		rmSync(fixture.projectLibrary, { recursive: true, force: true });
		mkdirSync(outsideProjectLibrary, { recursive: true });
		writeFileSync(join(outsideProjectLibrary, "review.md"), "review");
		writeFileSync(join(outsideProjectLibrary, "leak.md"), "project leak");
		symlinkSync(outsideProjectLibrary, fixture.projectLibrary, "dir");

		const projectResult = render(fixture, "body", ["leak.md"], {
			promptFilePath: join(fixture.projectLibrary, "review.md"),
			promptRoot: fixture.projectLibrary,
			rootKind: "prompt-library",
		});
		assertFail(projectResult);
		assert.equal(projectResult.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found" || diagnostic.code === "include-path-escaped"), true);

		const outsideUserLibrary = join(fixture.home, "outside-user-library");
		rmSync(fixture.userLibrary, { recursive: true, force: true });
		mkdirSync(outsideUserLibrary, { recursive: true });
		writeFileSync(join(outsideUserLibrary, "review.md"), "review");
		writeFileSync(join(outsideUserLibrary, "leak.md"), "user leak");
		symlinkSync(outsideUserLibrary, fixture.userLibrary, "dir");

		const userResult = render(fixture, "body", ["leak.md"], {
			promptFilePath: join(fixture.userLibrary, "review.md"),
			promptRoot: fixture.userLibrary,
			rootKind: "prompt-library",
		});
		assertFail(userResult);
		assert.equal(userResult.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found" || diagnostic.code === "include-path-escaped"), true);
	});
});

test("prompt-library include frontmatter is stripped and not inherited", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectLibrary, "rules.md"), "---\ndescription: hidden\ninclude: ignored.md\nmodel: nope\n---\nLibrary body");

		const result = render(fixture, "body", ["rules.md"]);

		assertOk(result);
		assert.equal(result.content, "Library body\n\nbody");
	});
});

test("nested includes work and cycles are detected across prompt-library files", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectLibrary, "outer.md"), 'outer <include file="inner.md" />');
		writeFileSync(join(fixture.projectLibrary, "inner.md"), "inner");
		const nested = render(fixture, "body", ["outer.md"]);
		assertOk(nested);
		assert.equal(nested.content, "outer inner\n\nbody");

		writeFileSync(join(fixture.projectLibrary, "a.md"), 'a <include file="b.md" />');
		writeFileSync(join(fixture.projectLibrary, "b.md"), 'b <include file="a.md" />');
		const cycle = render(fixture, "body", ["a.md"]);
		assertFail(cycle);
		assert.equal(cycle.diagnostics.some((diagnostic) => diagnostic.code === "include-cycle"), true);
	});
});

test("prompt-library include precedence shadowing is pinned", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.promptDir, "shadow.md"), "current-dir");
		writeFileSync(join(fixture.promptRoot, "shadow.md"), "owner-root");
		writeFileSync(join(fixture.projectLibrary, "shadow.md"), "project-library");
		writeFileSync(join(fixture.userLibrary, "shadow.md"), "user-library");
		writeFileSync(join(fixture.globalPartials, "shadow.md"), "global-partials");
		writeFileSync(join(fixture.projectPartials, "shadow.md"), "project-partials");
		writeFileSync(join(fixture.promptRoot, "owner.md"), "owner-root");
		writeFileSync(join(fixture.projectLibrary, "owner.md"), "project-library");
		writeFileSync(join(fixture.projectLibrary, "library.md"), "project-library");
		writeFileSync(join(fixture.userLibrary, "library.md"), "user-library");
		writeFileSync(join(fixture.projectLibrary, "legacy.md"), "project-library");
		writeFileSync(join(fixture.globalPartials, "legacy.md"), "global-partials");
		writeFileSync(join(fixture.globalPartials, "partials.md"), "global-partials");
		writeFileSync(join(fixture.projectPartials, "partials.md"), "project-partials");

		const result = render(fixture, "", ["shadow.md", "owner.md", "library.md", "legacy.md", "partials.md"]);

		assertOk(result);
		assert.equal(result.content, "current-dir\n\nowner-root\n\nproject-library\n\nproject-library\n\nglobal-partials");
	});
});

test("nested owner-root precedence follows the current prompt-library file", () => {
	withFixture((fixture) => {
		writeFileSync(join(fixture.projectLibrary, "common.md"), "project common");
		writeFileSync(join(fixture.userLibrary, "common.md"), "user common");
		writeFileSync(join(fixture.userLibrary, "base.md"), 'user base <include file="common.md" />');
		const userNested = render(fixture, "body", ["base.md"]);
		assertOk(userNested);
		assert.equal(userNested.content, "user base user common\n\nbody");

		writeFileSync(join(fixture.projectLibrary, "base.md"), 'project base <include file="common.md" />');
		const projectNested = render(fixture, "body", ["base.md"]);
		assertOk(projectNested);
		assert.equal(projectNested.content, "project base project common\n\nbody");
	});
});

test("include-not-found diagnostics mention prompt-library roots", () => {
	withFixture((fixture) => {
		const result = render(fixture, "body", ["missing.md"]);

		assertFail(result);
		const message = result.diagnostics.find((diagnostic) => diagnostic.code === "include-not-found")?.message ?? "";
		assert.match(message, /current owner root/);
		assert.match(message, /project prompt-library/);
		assert.match(message, /user prompt-library/);
	});
});
