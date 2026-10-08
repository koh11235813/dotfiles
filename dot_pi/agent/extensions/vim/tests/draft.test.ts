import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { CustomEditor, type ExtensionContext, type KeybindingsManager as AppKeybindingsManager } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, matchesKey, setKeybindings, type EditorTheme, type KeybindingsConfig, type TUI } from "@earendil-works/pi-tui";
import vim from "../index.ts";
import usageExtension from "../../usage/index.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;
const identity = (text: string) => text;
const theme: EditorTheme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity,
	description: identity, scrollInfo: identity, noMatch: identity } };

async function editorHost(bindings: KeybindingsConfig = {}) {
	const app = extensionHost();
	const keybindings = new KeybindingsManager({ ...TUI_KEYBINDINGS,
		"app.interrupt": { defaultKeys: "escape", description: "Interrupt" },
		"app.exit": { defaultKeys: "ctrl+d", description: "Exit" },
		"app.clipboard.pasteImage": { defaultKeys: "ctrl+v", description: "Paste" },
		"app.message.followUp": { defaultKeys: "alt+enter", description: "Follow up" },
	}, bindings);
	setKeybindings(keybindings);
	// Terminal rendering is the system boundary; editing and Vim are real implementations.
	const tui = { requestRender: () => {}, terminal: { rows: 40, columns: 100 } } as unknown as TUI;
	let editor: CustomEditor;
	app.ctx.ui.setEditorComponent = (factory: EditorFactory | undefined) => {
		assert.ok(factory);
		const currentText = editor?.getText() ?? "";
		if (editor) editor.focused = false;
		editor = factory(tui, theme, keybindings as AppKeybindingsManager) as CustomEditor;
		editor.setText(currentText);
		editor.focused = true;
		editor.onExtensionShortcut = (data) => {
			for (const [key, shortcut] of app.shortcuts) {
				if (matchesKey(data, key as Parameters<typeof matchesKey>[1])) { void shortcut.handler(app.ctx); return true; }
			}
			return false;
		};
	};
	app.ctx.ui.getEditorText = () => editor.getExpandedText();
	app.ctx.ui.setEditorText = (text) => editor.setText(text);
	vim(app.pi);
	await app.emit("session_start", { reason: "startup" });
	const submitted: string[] = [];
	const connect = () => {
		editor.onSubmit = async (text) => {
			if (!text.trim()) return;
			submitted.push(text);
			await app.emit("input", { text, source: "interactive" });
		};
	};
	connect();
	return { app, submitted, connect, get editor() { return editor; } };
}

test("Ctrl+Sで下書きを退避し、次の1件の送信直後にモデルの回答を待たず復元する", async () => {
	const host = await editorHost();
	host.editor.setText("長い依頼\nまだ書きかけ");
	host.editor.handleInput("\x13");
	assert.equal(host.editor.getText(), "");
	assert.match([...host.app.statuses.values(), ...host.app.widgets.values()].flat().join("\n"), /Draft saved/i);
	host.editor.handleInput("先に短い質問");
	host.editor.handleInput("\r");
	await setImmediate();
	assert.deepEqual(host.submitted, ["先に短い質問"]);
	assert.equal(host.editor.getExpandedText(), "長い依頼\nまだ書きかけ");
	assert.doesNotMatch([...host.app.statuses.values(), ...host.app.widgets.values()].flat().join("\n"), /Draft saved/i);
});

test("退避中のCtrl+Sは入力を上書きせず、空欄では元の下書きを手動復元する", async () => {
	const host = await editorHost();
	host.editor.setText("Original draft");
	host.editor.handleInput("\x13");
	host.editor.setText("Interrupting prompt");
	host.editor.handleInput("\x13");
	assert.equal(host.editor.getText(), "Interrupting prompt");
	host.editor.setText("");
	host.editor.handleInput("\r");
	await setImmediate();
	assert.deepEqual(host.submitted, []);
	host.editor.handleInput("\x13");
	assert.equal(host.editor.getText(), "Original draft");
	host.editor.handleInput("\x13");
	assert.equal(host.editor.getText(), "");
	host.editor.handleInput("\x13");
	assert.equal(host.editor.getText(), "Original draft");
});

test("長文貼り付けの本文と画像パスを退避・復元し、Vim normal操作と送信内容を保つ", async () => {
	const host = await editorHost();
	const draft = Array.from({ length: 14 }, (_, index) => `日本語の長文 ${index}`).join("\n") + "\n/tmp/pi-clipboard-example.png";
	host.editor.handleInput(`\x1b[200~${draft}\x1b[201~`);
	assert.notEqual(host.editor.getText(), host.editor.getExpandedText());
	host.editor.handleInput("\x1b");
	host.editor.handleInput("\x13");
	assert.equal(host.editor.getText(), "");
	host.editor.handleInput("Short question");
	host.editor.handleInput("\r");
	await setImmediate();
	assert.equal(host.editor.getExpandedText(), draft);
	host.editor.handleInput("\r");
	await setImmediate();
	assert.deepEqual(host.submitted, ["Short question", draft]);
	host.editor.handleInput("abc");
	host.editor.handleInput("\x1b");
	host.editor.handleInput("hx");
	assert.equal(host.editor.getText(), "ac");
});

test("非同期slash commandが送信後に入力欄をクリアしても、完了時に下書きを復元する", async () => {
	const host = await editorHost();
	host.editor.setText("Draft before export");
	host.editor.handleInput("\x13");
	host.editor.onSubmit = async (text) => {
		assert.equal(text, "/export");
		await setImmediate();
		host.editor.setText("");
	};
	host.editor.handleInput("/export");
	host.editor.handleInput("\r");
	await setImmediate();
	await setImmediate();
	assert.equal(host.editor.getText(), "Draft before export");
});

test("送信ハンドラが入力を戻した場合は上書きせず、保存した下書きを手動で取り戻せる", async () => {
	const host = await editorHost();
	host.editor.setText("Original draft");
	host.editor.handleInput("\x13");
	host.editor.onSubmit = () => { host.editor.setText("Rejected input"); };
	host.editor.handleInput("Question");
	host.editor.handleInput("\r");
	await setImmediate();
	assert.equal(host.editor.getText(), "Rejected input");
	host.editor.setText("");
	host.editor.handleInput("\x13");
	assert.equal(host.editor.getText(), "Original draft");
});

test("送信キーを変更しても動作し、改行では保存した下書きを消費しない", async () => {
	const host = await editorHost({ "tui.input.submit": "ctrl+enter" });
	host.editor.setText("Draft");
	host.editor.handleInput("\x13");
	host.editor.handleInput("Question");
	host.editor.handleInput("\x1b[13;2u");
	assert.deepEqual(host.submitted, []);
	assert.equal(host.editor.getText(), "Question\n");
	host.editor.handleInput("\x1b[13;5u");
	await setImmediate();
	assert.deepEqual(host.submitted, ["Question"]);
	assert.equal(host.editor.getText(), "Draft");
});

test("保存だけでは自動復元せず、reload後は復元し、別セッションには持ち込まない", async () => {
	const host = await editorHost();
	host.editor.setText("Session A draft");
	host.editor.handleInput("\x13");
	const sessionA = host.app.manager;
	await host.app.emit("session_start", { reason: "startup" });
	host.connect();
	host.editor.render(100);
	assert.equal(host.editor.getText(), "");
	await host.app.emit("session_start", { reason: "reload" });
	host.connect();
	host.editor.render(100);
	assert.equal(host.editor.getText(), "Session A draft");
	host.editor.handleInput("\x13");
	host.app.replaceSession();
	await host.app.emit("session_start", { reason: "new" });
	host.connect();
	host.editor.handleInput("Session B question");
	host.editor.handleInput("\r");
	await setImmediate();
	assert.equal(host.editor.getText(), "");
	host.app.replaceSession(sessionA);
	await host.app.emit("session_start", { reason: "switch" });
	host.connect();
	host.editor.handleInput("\x13");
	assert.equal(host.editor.getText(), "Session A draft");
});

test("応答中のAlt+Enterで次の指示をキューに入れた後にも下書きを復元する", async () => {
	const host = await editorHost();
	host.editor.setText("Saved draft");
	host.editor.handleInput("\x13");
	await host.app.emit("input", { text: "Extension message", source: "extension", streamingBehavior: "followUp" });
	assert.equal(host.editor.getText(), "");
	host.editor.onAction("app.message.followUp", () => {
		const text = host.editor.getExpandedText().trim();
		if (!text) return;
		host.submitted.push(text);
		host.editor.setText("");
		void host.app.emit("input", { text, source: "interactive", streamingBehavior: "followUp" });
	});
	host.editor.handleInput("Next instruction");
	host.editor.handleInput("\x1b[13;3u");
	await setImmediate();
	assert.deepEqual(host.submitted, ["Next instruction"]);
	assert.equal(host.editor.getText(), "Saved draft");
});

test("treeで退避時点に戻るとそのブランチの下書きを復元する", async () => {
	const host = await editorHost();
	host.editor.setText("Branch draft");
	host.editor.handleInput("\x13");
	const saved = host.app.manager.getLeafId()!;
	host.editor.handleInput("\x13");
	host.editor.setText("");
	host.app.manager.branch(saved);
	await host.app.emit("session_tree");
	host.connect();
	host.editor.handleInput("\x13");
	assert.equal(host.editor.getText(), "Branch draft");
});

test("非同期exportの処理中に手動復元しても、後続の入力クリアで下書きを失わない", async () => {
	const host = await editorHost();
	let finish!: () => void;
	const exporting = new Promise<void>((resolve) => { finish = resolve; });
	host.editor.setText("Keep this draft");
	host.editor.handleInput("\x13");
	host.editor.onSubmit = async () => {
		await exporting;
		host.editor.setText("");
	};
	host.editor.handleInput("/export");
	host.editor.handleInput("\r");
	host.editor.handleInput("\x13");
	finish();
	await setImmediate();
	if (!host.editor.getText()) host.editor.handleInput("\x13");
	assert.equal(host.editor.getText(), "Keep this draft");
});

test("応答中のAlt+Enterで拡張コマンドを実行してinputイベントがなくても復元する", async () => {
	const host = await editorHost();
	usageExtension(host.app.pi);
	host.editor.setText("Draft before usage");
	host.editor.handleInput("\x13");
	host.editor.onAction("app.message.followUp", async () => {
		const text = host.editor.getExpandedText().trim();
		if (!text) return;
		host.editor.setText("");
		assert.equal(text, "/usage");
		// Pi handles extension commands before input events, also for streaming followUp.
		await host.app.command("usage");
	});
	host.editor.handleInput("/usage");
	host.editor.handleInput("\x1b[13;3u");
	await setImmediate();
	assert.match(host.app.notices.at(-1)!, /Latest turn/);
	assert.equal(host.editor.getText(), "Draft before usage");
});

test("/reloadでエディタが作り直されてもコマンド後に下書きを自動復元する", async () => {
	const host = await editorHost();
	host.editor.setText("Draft before reload");
	host.editor.handleInput("\x13");
	host.editor.onSubmit = async (text) => {
		assert.equal(text, "/reload");
		host.app.resetRuntime();
		vim(host.app.pi);
		await host.app.emit("session_start", { reason: "reload" });
		host.connect();
	};
	host.editor.handleInput("/reload");
	host.editor.handleInput("\r");
	await setImmediate();
	host.editor.render(100);
	assert.equal(host.editor.getText(), "Draft before reload");
	assert.doesNotMatch([...host.app.statuses.values()].join("\n"), /Draft saved/i);
});

test("/settingsの選択画面を閉じたら下書きを自動復元する", async () => {
	const host = await editorHost();
	host.editor.setText("Draft before settings");
	host.editor.handleInput("\x13");
	host.editor.onSubmit = (text) => {
		assert.equal(text, "/settings");
		host.editor.focused = false;
	};
	host.editor.handleInput("/settings");
	host.editor.handleInput("\r");
	await setImmediate();
	assert.equal(host.editor.getText(), "");
	host.editor.focused = true;
	host.editor.render(100);
	assert.equal(host.editor.getText(), "Draft before settings");
	assert.doesNotMatch([...host.app.statuses.values()].join("\n"), /Draft saved/i);
});

test("コマンド後に別の入力がある場合は復元待ちでも上書きしない", async () => {
	const host = await editorHost();
	host.editor.setText("Original draft");
	host.editor.handleInput("\x13");
	host.editor.onSubmit = () => { host.editor.focused = false; };
	host.editor.handleInput("/model");
	host.editor.handleInput("\r");
	await setImmediate();
	host.editor.setText("New input");
	host.editor.focused = true;
	host.editor.render(100);
	assert.equal(host.editor.getText(), "New input");
	host.editor.setText("");
	host.editor.handleInput("\x13");
	assert.equal(host.editor.getText(), "Original draft");
});

test("/new後には元の下書きを自動復元せず、元セッションに戻れば手動で回収できる", async () => {
	const host = await editorHost();
	host.editor.setText("Original session draft");
	host.editor.handleInput("\x13");
	const original = host.app.manager;
	host.editor.onSubmit = async () => {
		host.app.replaceSession();
		await host.app.emit("session_start", { reason: "new" });
		host.connect();
	};
	host.editor.handleInput("/new");
	host.editor.handleInput("\r");
	await setImmediate();
	host.editor.render(100);
	assert.equal(host.editor.getText(), "");
	host.app.replaceSession(original);
	await host.app.emit("session_start", { reason: "switch" });
	host.connect();
	host.editor.render(100);
	assert.equal(host.editor.getText(), "");
	host.editor.handleInput("\x13");
	assert.equal(host.editor.getText(), "Original session draft");
});

test("exportと次のコマンドが重なっても、古い完了処理で復元した下書きを消さない", async () => {
	const host = await editorHost();
	let finish!: () => void;
	const exporting = new Promise<void>((resolve) => { finish = resolve; });
	host.editor.setText("Keep this draft");
	host.editor.handleInput("\x13");
	host.editor.onSubmit = async (text) => {
		if (text === "/export") { await exporting; host.editor.setText(""); }
	};
	host.editor.handleInput("/export");
	host.editor.handleInput("\r");
	host.editor.handleInput("/usage");
	host.editor.handleInput("\r");
	await setImmediate();
	finish();
	await setImmediate();
	if (!host.editor.getText()) host.editor.handleInput("\x13");
	assert.equal(host.editor.getText(), "Keep this draft");
});
