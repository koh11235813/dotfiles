import assert from "node:assert/strict";
import { test } from "node:test";
import compactjev from "../index.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

const LOG = `${"connecting…\n".repeat(1500)}Error: connect ECONNREFUSED 127.0.0.1:5432\n${"retrying…\n".repeat(1500)}`;

/** 圧縮で文脈から消えた範囲 (依頼、呼び出し、長い結果) と、その後の発言を持つセッション。 */
function session() {
	const app = extensionHost();
	compactjev(app.pi);
	const ids = {
		request: app.manager.appendMessage({ role: "user", content: "DB に繋がらない原因を調べて", timestamp: 0 } as never),
		call: app.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "接続を試します。" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "psql -h localhost" } }], timestamp: 0 } as never),
		result: app.manager.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: LOG }], isError: true, timestamp: 0 } as never),
		kept: app.manager.appendMessage({ role: "user", content: "続けて", timestamp: 0 } as never),
	};
	app.manager.appendCompaction("要約", ids.kept, 1000);
	const tool = app.registeredTools.get("session_recall") as unknown as { annotations?: { readOnlyHint?: boolean }; promptSnippet?: string; execute: Function };
	const recall = async (params: { query?: string; id?: string; offset?: number }): Promise<string> => (await tool.execute("call-recall", params, undefined, undefined, app.ctx)).content[0].text;
	return { app, ids, tool, recall };
}

test("session_recall は圧縮前の履歴を語で探し、新しい順に id と一致箇所の前後だけを返す", async () => {
	const { ids, recall } = session();
	const found = await recall({ query: "econnrefused 5432" });
	assert.ok(found.startsWith("1 matching entry"));
	assert.ok(found.includes(`id ${ids.result} (tool call c1), tool result (error), ${LOG.length} chars`));
	assert.ok(found.includes("Error: connect ECONNREFUSED 127.0.0.1:5432"));
	assert.ok(found.length < 600);
	const both = await recall({ query: "PSQL" });
	assert.ok(both.includes(`id ${ids.call}, assistant`) && both.includes('bash(command="psql -h localhost")'));
	assert.equal(await recall({ query: "no-such-word" }), 'No entry in this session matches "no-such-word".');
});

test("session_recall は id か toolCallId で 1 件の全文を返し、長いものは offset で続きを返す", async () => {
	const { ids, recall } = session();
	assert.equal(await recall({ id: ids.request }), "DB に繋がらない原因を調べて");
	const head = await recall({ id: ids.result });
	const note = `\n[${LOG.length - 10000} more chars; call again with offset=10000]`;
	assert.equal(head, `${LOG.slice(0, 10000)}${note}`);
	let text = LOG.slice(0, 10000);
	for (let offset = 10000; offset < LOG.length; offset += 10000) text += (await recall({ id: ids.result, offset })).replace(/\n\[\d+ more chars; call again with offset=\d+\]$/, "");
	assert.equal(text, LOG);
});

test("session_recall は読むだけの道具として登録され、引数が無いか id が無ければ失敗する", async () => {
	const { tool, recall } = session();
	assert.equal(tool.annotations?.readOnlyHint, true);
	assert.ok(tool.promptSnippet);
	await assert.rejects(recall({}), /pass query or id/);
	await assert.rejects(recall({ id: "nope" }), /no entry with id nope/);
});

test("session_recall の検索は、session_recall 自身の呼び出しと結果には一致しない", async () => {
	const { app, ids, recall } = session();
	// Pi は道具を実行する前に、その呼び出しを持つ assistant の entry を枝に足している。
	app.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "r1", name: "session_recall", arguments: { query: "econnrefused" } }], timestamp: 0 } as never);
	const earlier = app.manager.appendMessage({ role: "toolResult", toolCallId: "r1", toolName: "session_recall", content: [{ type: "text", text: "1 matching entry.\n…ECONNREFUSED zzzunique…" }], isError: false, timestamp: 0 } as never);
	app.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "もう一度探します。" }, { type: "toolCall", id: "call-recall", name: "session_recall", arguments: { query: "zzzunique qqqother" } }], timestamp: 0 } as never);
	assert.equal(await recall({ query: "zzzunique qqqother" }), 'No entry in this session matches "zzzunique qqqother".');
	const found = await recall({ query: "econnrefused" });
	assert.ok(found.startsWith("1 matching entry") && found.includes(`id ${ids.result} `));
	assert.ok((await recall({ query: "もう一度" })).startsWith("1 matching entry"));
	// id で引くほうは塞がない。calls モードが畳んだ session_recall の結果も引き直せる。
	assert.equal(await recall({ id: earlier }), "1 matching entry.\n…ECONNREFUSED zzzunique…");
});

test("session_recall は toolCallId で、呼び出しの引数と結果の両方を全文で返す", async () => {
	const { app, recall } = session();
	// write と edit では、書いた中身は結果ではなく引数にある。
	const content = "A".repeat(3600);
	app.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "書きます。" }, { type: "toolCall", id: "w1", name: "write", arguments: { path: "a.txt", content } }, { type: "toolCall", id: "w2", name: "write", arguments: { path: "b.txt", content: "B" } }], timestamp: 0 } as never);
	app.manager.appendMessage({ role: "toolResult", toolCallId: "w1", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0 } as never);
	assert.equal(await recall({ id: "w1" }), `[Tool call]: write(path="a.txt", content="${content}")\n[Tool result]: ok`);
	// 結果がまだ無い呼び出しと、失敗した結果。
	assert.equal(await recall({ id: "w2" }), '[Tool call]: write(path="b.txt", content="B")');
	const failed = await recall({ id: "c1" });
	assert.ok(failed.startsWith(`[Tool call]: bash(command="psql -h localhost")\n[Tool result (error)]: ${LOG.slice(0, 100)}`));
	assert.match(failed, /more chars; call again with offset=10000\]$/);
});

test("session_recall の検索は新しい順に 10 件までを返す", async () => {
	const { app, recall } = session();
	const ids = Array.from({ length: 12 }, (_, i) => app.manager.appendMessage({ role: "user", content: `kiwi ${i}`, timestamp: 0 } as never));
	const found = await recall({ query: "kiwi" });
	assert.ok(found.startsWith("12 matching entries, newest first, first 10 shown."));
	assert.deepEqual([...found.matchAll(/^id (\S+), user/gm)].map((match) => match[1]), ids.reverse().slice(0, 10));
});

test("session_recall は、Pi が文脈から外した entry を返さず、置き換えた entry は置き換え後の本文で返す", async () => {
	const { app, ids, recall } = session();
	const secret = app.manager.appendMessage({ role: "toolResult", toolCallId: "s1", toolName: "bash", content: [{ type: "text", text: "TOKEN=hunter2-secret" }], isError: false, timestamp: 0 } as never);
	const said = app.manager.appendMessage({ role: "user", content: "zebra の件は内密に", timestamp: 0 } as never);
	app.manager.appendContextEdit(secret, null);
	app.manager.appendContextEdit(said, { content: "redacted" });
	// 後の編集が前の編集に勝つ。
	app.manager.appendContextEdit(ids.request, { content: "一度目" });
	app.manager.appendContextEdit(ids.request, { content: "二度目" });
	assert.equal(await recall({ query: "hunter2" }), 'No entry in this session matches "hunter2".');
	await assert.rejects(recall({ id: "s1" }), /no entry with id s1/);
	await assert.rejects(recall({ id: secret }), /no entry with id/);
	assert.equal(await recall({ query: "zebra" }), 'No entry in this session matches "zebra".');
	assert.equal(await recall({ id: said }), "redacted");
	assert.equal(await recall({ id: ids.request }), "二度目");
});
