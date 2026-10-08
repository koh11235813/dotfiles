import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import goal from "../index.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

test("/goal で目的を設定すると表示され、他のプロンプト規則を保ってモデルに渡される", async () => {
	const app = extensionHost();
	goal(app.pi);
	await app.emit("session_start");
	await app.command("goal", "ログインを修正。APIは変更しない。回帰テスト通過で完了。");
	await app.command("goal");
	assert.match(app.notices.at(-1)!, /ログインを修正/);
	assert.match([...app.widgets.values()].flat().join("\n"), /ログインを修正/);
	const sections = await app.prompt();
	assert.equal(sections.other, "Keep me");
	assert.match(Object.values(sections).join("\n"), /APIは変更しない/);
});

test("目的は再開とcompact後に保持され、treeでは移動先に戻り、clearと新規セッションで解除される", async () => {
	const app = extensionHost();
	goal(app.pi);
	await app.emit("session_start");
	await app.command("goal", "First goal");
	const first = app.manager.getLeafId()!;
	await app.command("goal", "Second goal");
	const resumed = extensionHost();
	resumed.replaceSession(SessionManager.inMemory(process.cwd(), undefined, [app.manager.getHeader()!, ...app.manager.getEntries()]));
	goal(resumed.pi);
	await resumed.emit("session_start", { reason: "resume" });
	assert.match(Object.values(await resumed.prompt()).join("\n"), /Second goal/);
	resumed.manager.appendCompaction("Summary", first, 100);
	await resumed.emit("session_compact");
	assert.match(Object.values(await resumed.prompt()).join("\n"), /Second goal/);
	resumed.manager.branch(first);
	await resumed.emit("session_tree");
	assert.match(Object.values(await resumed.prompt()).join("\n"), /First goal/);
	assert.doesNotMatch(Object.values(await resumed.prompt()).join("\n"), /Second goal/);
	await resumed.command("goal", "clear");
	assert.deepEqual(await resumed.prompt({ other: "Keep me", goal: "Stale" }), { other: "Keep me" });
	await resumed.emit("session_start", { reason: "resume" });
	assert.deepEqual(await resumed.prompt(), { other: "Keep me" });
	assert.equal([...resumed.widgets.values()].filter(Boolean).length, 0);
	await resumed.command("goal", "Old session goal");
	resumed.replaceSession();
	await resumed.emit("session_start", { reason: "new" });
	assert.deepEqual(await resumed.prompt(), { other: "Keep me" });
});
