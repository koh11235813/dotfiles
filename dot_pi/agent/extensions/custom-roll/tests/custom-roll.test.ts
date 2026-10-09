import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import customRoll from "../index.ts";

function setup(t: TestContext) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-custom-roll-test-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		rmSync(agentDir, { recursive: true, force: true });
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	const rollDir = join(agentDir, "custom-roll");
	mkdirSync(rollDir);
	let branch: Array<{ type: string; customType?: string; data?: unknown }> = [];
	const saved: typeof branch = [];
	const handlers = new Map<string, Function>();
	const pi = {
		on: (event: string, handler: Function) => handlers.set(event, handler),
		appendEntry: (customType: string, data: unknown) => {
			const entry = { type: "custom", customType, data };
			branch.push(entry);
			saved.push(entry);
		},
	};
	const ctx = { sessionManager: { getBranch: () => branch } };
	const load = () => customRoll(pi as unknown as ExtensionAPI);
	load();
	return {
		agentDir, rollDir, saved, load,
		setBranch: (entries: typeof branch) => { branch = entries; },
		start: (reason = "startup") => handlers.get("session_start")!({ type: "session_start", reason }, ctx),
		tree: () => handlers.get("session_tree")!({ type: "session_tree" }, ctx),
		prompt: (sections: Record<string, string> = { other: "Keep me" }) => {
			const event = { systemPromptOptions: { sections } };
			handlers.get("before_agent_start")!(event, ctx);
			return event.systemPromptOptions.sections as Record<string, string>;
		},
	};
}

test("新規セッションで選んだ口調を保存してプロンプトに反映する", (t) => {
	const app = setup(t);
	writeFileSync(join(app.rollDir, "one.md"), "Speak gently.\n");
	app.start();
	assert.deepEqual(app.saved, [{
		type: "custom", customType: "custom-roll",
		data: { version: 1, name: "one.md", content: "Speak gently.\n" },
	}]);
	assert.deepEqual(app.prompt(), { other: "Keep me", custom_roll: "Speak gently.\n" });
});

test("resume・reload は元ファイルの変更や削除後も保存した本文を使う", (t) => {
	const app = setup(t);
	const file = join(app.rollDir, "one.md");
	writeFileSync(file, "Original tone.");
	app.start();
	writeFileSync(file, "Changed tone.");
	app.start();
	assert.equal(app.prompt().custom_roll, "Original tone.");
	rmSync(app.rollDir, { recursive: true });
	app.load();
	app.start();
	assert.equal(app.prompt().custom_roll, "Original tone.");
	assert.equal(app.saved.length, 1);
});

test("tree 移動では放棄したブランチの口調を使わず、移動先から復元する", (t) => {
	const app = setup(t);
	writeFileSync(join(app.rollDir, "one.md"), "First branch.");
	app.start();
	app.setBranch([{
		type: "custom", customType: "custom-roll",
		data: { version: 1, name: "two.md", content: "Second branch." },
	}]);
	app.tree();
	assert.equal(app.prompt().custom_roll, "Second branch.");
	assert.equal(app.saved.length, 1);
	app.setBranch([]);
	rmSync(app.rollDir, { recursive: true });
	app.tree();
	assert.deepEqual(app.prompt({ other: "Keep me", custom_roll: "Stale tone." }), { other: "Keep me" });
});

test("新しいセッションでは再選択し、fork は引き継いだ entry を使う", (t) => {
	const app = setup(t);
	const file = join(app.rollDir, "one.md");
	writeFileSync(file, "First session.");
	app.start();
	app.start("fork");
	assert.equal(app.prompt().custom_roll, "First session.");
	assert.equal(app.saved.length, 1);
	writeFileSync(file, "New session.");
	app.setBranch([]);
	app.start("new");
	assert.equal(app.prompt().custom_roll, "New session.");
	assert.equal(app.saved.length, 2);
});

test("繰り返すターンと compact 後にも一つのセクションだけを適用する", (t) => {
	const app = setup(t);
	writeFileSync(join(app.rollDir, "one.md"), "Stable tone.");
	app.start();
	const sections = app.prompt();
	assert.deepEqual(app.prompt(sections), { other: "Keep me", custom_roll: "Stable tone." });
	// Compaction truncates model context, not custom entries in the active branch.
	app.setBranch([...app.saved, { type: "compaction" }]);
	assert.deepEqual(app.prompt(), { other: "Keep me", custom_roll: "Stable tone." });
	assert.equal(app.saved.length, 1);
});

test("共有ディレクトリへの symlink をたどり、直下の非空 .md だけを候補にする", (t) => {
	const app = setup(t);
	const sharedDir = join(app.agentDir, "shared-roles");
	renameSync(app.rollDir, sharedDir);
	symlinkSync(sharedDir, app.rollDir);
	writeFileSync(join(sharedDir, "one.md"), "Shared tone.");
	writeFileSync(join(sharedDir, "empty.md"), " \n\t");
	writeFileSync(join(sharedDir, "notes.txt"), "Not a role.");
	mkdirSync(join(sharedDir, "nested.md"));
	writeFileSync(join(sharedDir, "nested.md", "nested.md"), "Nested tone.");
	symlinkSync(join(sharedDir, "missing.md"), join(sharedDir, "broken.md"));
	app.start();
	assert.equal(app.prompt().custom_roll, "Shared tone.");
});

test("複数の候補から選んだ本文とファイル名が一致する", (t) => {
	const app = setup(t);
	for (const name of ["one.md", "two.md", "three.md"]) {
		writeFileSync(join(app.rollDir, name), `Tone from ${name}`);
	}
	app.start();
	const data = app.saved[0].data as { name: string; content: string };
	assert.ok(["one.md", "two.md", "three.md"].includes(data.name));
	assert.equal(app.prompt().custom_roll, `Tone from ${data.name}`);
});

test("候補が空・ディレクトリがない・パスがファイルでも Pi を止めない", (t) => {
	const app = setup(t);
	for (const state of ["empty", "missing", "file"]) {
		if (state === "missing") rmSync(app.rollDir, { recursive: true });
		if (state === "file") writeFileSync(app.rollDir, "Not a directory.");
		assert.doesNotThrow(() => app.start());
		assert.deepEqual(app.prompt(), { other: "Keep me" });
	}
	assert.equal(app.saved.length, 0);
});

test("読めない候補を除外して、読める口調を使う", (t) => {
	if (process.getuid?.() === 0) return t.skip("root can read mode-000 files");
	const app = setup(t);
	const blocked = join(app.rollDir, "blocked.md");
	writeFileSync(blocked, "Unreadable tone.");
	chmodSync(blocked, 0o000);
	writeFileSync(join(app.rollDir, "one.md"), "Readable tone.");
	app.start();
	assert.equal(app.prompt().custom_roll, "Readable tone.");
});

test("保存 entry は検証し、別タイプや不正値を無視して最新の有効な値を使う", (t) => {
	const app = setup(t);
	const valid = { version: 1, name: "one.md", content: "Saved tone." };
	app.setBranch([
		{ type: "custom", customType: "custom-roll", data: { ...valid, content: "Older tone." } },
		{ type: "custom", customType: "custom-roll", data: valid },
		{ type: "custom", customType: "other", data: { ...valid, content: "Unrelated tone." } },
		...[undefined, null, "invalid", {}, { ...valid, version: 2 },
			{ ...valid, name: 7 }, { ...valid, content: " \n" }].map((data) => ({
				type: "custom", customType: "custom-roll", data,
			})),
	]);
	app.start("resume");
	assert.equal(app.prompt().custom_roll, "Saved tone.");
	assert.equal(app.saved.length, 0);
});
