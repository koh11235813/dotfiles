/**
 * vim — Pi の入力欄を vim 風のモーダル編集にする。キーの意味は vim.ts、ここは Pi への適用だけ。
 *
 * Editor の公開メンバーだけで作ってある。非公開の state や setCursorCol に触れば楽だが、
 * Pi の更新で名前や意味が変わってもエラーにならず、入力欄だけがおかしくなる。そのせいで次の回り道をしている。
 *
 * - カーソルの setter が無い。左右の矢印キーを Pi に送り、getCursor() が目標に着くまで繰り返す。
 * - 範囲を消す手段が無い。削除は setText() で全文を置き換えてから、カーソルを運び直す。
 * - 選択範囲を描けないので visual モードは無い。
 *
 * 使えるキーの一覧は vim.ts。ここで Pi に任せているのは Enter (送信)、`u` (Pi の undo)、
 * 端の行での `j` `k` (入力履歴)、Ctrl つきのキーや矢印、貼り付け。
 */

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ESC, graphemes, type Outcome, type Position, Vim } from "./vim.ts";

/**
 * Pi に送るキー。Pi の既定の割り当て (tui.editor.cursorLeft など) に合わせた固定値で、
 * keybindings.json でこれらを外すと動かなくなる。`\x1f` は ctrl+- で、tui.editor.undo の既定。
 * 行頭と行末は Home / End。ctrl+a / ctrl+e でも同じだが、ctrl+a はアプリ側の操作にも割り当てがある。
 */
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const HOME = "\x1b[H";
const END = "\x1b[F";
/**
 * up は先頭行の途中にいると、Pi が 1 回目を行頭への移動に使う。履歴に入るのは 2 回目の `k` から。
 */
const PASS = { up: "\x1b[A", down: "\x1b[B", undo: "\x1f" } as const;

/** a が b より前なら負、後ろなら正。 */
const compare = (a: Position, b: Position): number => Math.sign(a.line - b.line || a.col - b.col);

/**
 * 印字可能なキーの並び。制御キー (Ctrl つき、矢印、貼り付け) なら undefined。
 * 文字は 3 通りの形で届くので、生のバイトとは比べない。
 * - kitty keyboard protocol の CSI-u。
 * - xterm の modifyOtherKeys (`CSI 27 ; 修飾 ; 文字コード ~`)。kitty 非対応の端末で Pi が有効にし、
 *   Shift つきの文字がこの形になる。Pi の decodePrintableKey は両方を解くが export されていない
 *   ので、こちらだけ自前で解く。修飾は 1 (なし) と 2 (Shift) だけを文字として扱う。
 * - 素の文字。1 回に複数文字のことがある (速い `dd`、IME の確定) ので書記素に割る。
 */
function printableKeys(data: string): string[] | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return [kitty];
	const other = /^\x1b\[27;[12];(\d+)~$/.exec(data);
	if (other) return Number(other[1]) >= 32 ? [String.fromCodePoint(Number(other[1]))] : undefined;
	return /[\x00-\x1f\x7f]/.test(data) ? undefined : graphemes(data);
}

const DRAFT_ENTRY = "vim-draft";
type Draft = { text: string };

/** 不明な版や壊れたデータは保存スロットとして採用しない。null は復元済みの記録。 */
function readDraft(data: unknown): Draft | null | undefined {
	if (typeof data !== "object" || data === null || !("version" in data) || data.version !== 1 || !("text" in data)) return undefined;
	if (data.text === null) return null;
	return typeof data.text === "string" && data.text.trim() ? { text: data.text } : undefined;
}

interface Host {
	isActive: (editor: VimEditor) => boolean;
	saveDraft: (draft: Draft | undefined) => void;
	/** エージェントが応答中でないか。 */
	isIdle: () => boolean;
	warn: (message: string) => void;
	setDraftStatus: (message: string | undefined) => void;
}

/**
 * 自前のメンバーは `#` つきにしてある。TypeScript の private は実行時にはただのプロパティなので、
 * Pi が将来 Editor に同じ名前を足すと、エラーにならないまま互いの値を上書きする。
 */
class VimEditor extends CustomEditor {
	#vim = new Vim();
	#host: Host;
	#draft: Draft | undefined;
	#pendingSubmissions = 0;
	#restoreRequested: Draft | undefined;

	constructor(host: Host, draft: Draft | undefined, restoreRequested: boolean, ...args: ConstructorParameters<typeof CustomEditor>) {
		super(...args);
		this.#host = host;
		this.#draft = draft;
		if (restoreRequested) this.#restoreRequested = draft;
	}

	#isActive(): boolean {
		// 別のエディタやダイアログにフォーカスが移った後の非同期完了は入力を変えない。
		return this.#host.isActive(this) && this.focused;
	}

	#restoreAfterSubmit(text: string, draft: Draft): void {
		// 同じ本文を保存し直した場合も、古い送信の完了では消費しない。
		if (!this.#host.isActive(this) || !text.trim() || this.#draft !== draft) return;
		this.#restoreRequested = draft;
		this.#retryRestore();
	}

	#retryRestore(): void {
		const draft = this.#restoreRequested;
		if (draft === undefined || this.#draft !== draft || !this.#isActive() || this.getText() !== "") return;
		this.#restoreDraft(draft);
	}

	#restoreDraft(draft: Draft): void {
		// どの送信も完了前に入力を消しうる。手動復元や followUp でも保存スロットを先に消費しない。
		if (this.#pendingSubmissions > 0) return;
		this.setText(draft.text);
		this.#host.saveDraft(undefined);
		this.#draft = undefined;
		this.#restoreRequested = undefined;
		this.#vim = new Vim();
		this.#host.setDraftStatus(undefined);
		this.tui.requestRender();
	}

	#trackSubmission(text: string, submit: () => void): void | Promise<void> {
		if (!text.trim()) return submit();
		const draft = this.#draft;
		// 退避前に始まった送信も、あとから保存した下書きの復元を止める。
		// 待機中の followUp は onSubmit を呼ぶ。両方を数え、最後の完了だけが復元する。
		this.#pendingSubmissions++;
		let result: ReturnType<typeof submit>;
		try {
			result = submit();
		} catch (error) {
			this.#pendingSubmissions--;
			throw error;
		}
		// SDK の型は void だが、onSubmit と followUp は実行時に Promise を返す。
		return Promise.resolve(result).finally(() => {
			this.#pendingSubmissions--;
		}).then(() => {
			if (draft !== undefined) this.#restoreAfterSubmit(text, draft);
			this.#retryRestore();
		}).catch((error: unknown) => {
			try {
				if (this.#isActive()) this.#host.warn(`vim: 送信後の下書き復元に失敗しました: ${String(error)}`);
			} catch {
				// 古い ctx への通知が失敗しても、未処理の Promise rejection を作らない。
			}
		});
	}

	handleInput(data: string): void {
		if (!this.#isActive()) return;
		// コールバックは factory が返ったあとで Pi が設定する。/export や応答中の拡張コマンドは
		// 非同期処理のあとで入力を消すので、input イベントでなく正常完了まで復元を待つ。
		const submit = this.onSubmit;
		const followUp = this.actionHandlers.get("app.message.followUp");
		const wrappedSubmit = submit ? (text: string) => this.#trackSubmission(text, () => submit(text)) : undefined;
		const wrappedFollowUp = followUp ? () => this.#trackSubmission(this.getExpandedText(), followUp) : undefined;
		if (wrappedSubmit) this.onSubmit = wrappedSubmit;
		if (wrappedFollowUp) this.actionHandlers.set("app.message.followUp", wrappedFollowUp);
		try {
			this.#handleInput(data);
		} finally {
			if (wrappedSubmit && this.onSubmit === wrappedSubmit) this.onSubmit = submit;
			if (followUp && this.actionHandlers.get("app.message.followUp") === wrappedFollowUp) {
				this.actionHandlers.set("app.message.followUp", followUp);
			}
		}
	}

	#handleInput(data: string): void {
		// Pi は離す側のイベントを普通は届けないが、届くと Esc が 2 回押されたことになる。
		if (isKeyRelease(data)) return;

		if (matchesKey(data, "ctrl+s")) {
			const text = this.getExpandedText();
			if (this.#draft !== undefined) {
				if (text.trim()) {
					this.#host.warn("vim: 下書きは保存済みです。入力欄を空にしてから Ctrl+S で復元してください。");
					return;
				}
				this.#restoreDraft(this.#draft);
				return;
			}
			if (!text.trim()) return;
			const draft = { text };
			this.#host.saveDraft(draft);
			this.#draft = draft;
			this.setText("");
			this.#vim = new Vim();
			this.#host.setDraftStatus("Draft saved");
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "escape")) {
			// 補完メニューが出ている間の Esc はメニューを閉じるだけ。Pi に渡してモードは変えない。
			if (this.isShowingAutocomplete()) super.handleInput(data);
			else if (this.#vim.mode === "insert" || this.#vim.pending) this.#apply(this.#vim.press(ESC, this.#buffer()));
			// Pi の中断 (app.interrupt) は Esc にしか割り当てが無い。応答中だけは渡さないと止める手段が消える。
			// 待機中の Esc は Pi 側の別の動作になるので渡さない。normal で Esc を連打する癖と衝突する。
			else if (!this.#host.isIdle()) super.handleInput(data);
			return;
		}
		if (this.#vim.mode === "insert") {
			super.handleInput(data);
			return;
		}

		const keys = printableKeys(data);
		if (!keys) {
			this.#pass(data);
			return;
		}
		for (const key of keys) this.#press(key);
	}

	render(width: number): string[] {
		// selector の終了と reload 後のフォーカス復帰は render 境界で拾う。タイマーは不要。
		this.#retryRestore();
		const lines = super.render(width);
		// 補完メニューは下枠の下に描かれる。最終行が枠でないので、表示を載せるとメニューを潰す。
		if (lines.length === 0 || this.isShowingAutocomplete()) return lines;

		const pending = this.#vim.pending;
		const label = this.#vim.mode === "insert" ? " INSERT " : pending ? ` NORMAL ${pending} ` : " NORMAL ";
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
		}
		return lines;
	}

	#press(key: string): void {
		// 1 回の入力の途中で insert に入ったら (`ifoo` が一度に届く)、残りは文字として入れる。
		if (this.#vim.mode === "insert") super.handleInput(key);
		else this.#apply(this.#vim.press(key, this.#buffer()));
	}

	#buffer() {
		// setText() は paste の表を空にする。`[paste #1 +123 lines]` のマーカーが残って中身だけ消えるので、
		// マーカーがある間は全文の置き換えをさせない。
		return { lines: this.getLines(), ...this.getCursor(), frozen: this.getText() !== this.getExpandedText() };
	}

	#apply(outcome: Outcome): void {
		if (outcome.refused) {
			this.#host.warn("vim: 貼り付けマーカーがある間は削除できません。Ctrl+G で外部エディタを開いて編集してください。");
			return;
		}
		// vim の 1 コマンドが Pi の undo 1 回になるよう、編集は setText か insertTextAtCursor の 1 回だけ。
		if (outcome.text !== undefined) this.setText(outcome.text);
		if (outcome.insert) {
			this.#moveTo(outcome.insert.at);
			this.insertTextAtCursor(outcome.insert.text);
		}
		if (outcome.cursor) this.#moveTo(outcome.cursor);
		if (outcome.pass) this.#pass(PASS[outcome.pass]);
	}

	/** Pi にキーを渡す。そのあとの状態は Pi が決めるので、normal モードの決まりに合わせ直す。 */
	#pass(data: string): void {
		super.handleInput(data);
		// 送信で入力欄が空になったら insert に戻す。次の指示をそのまま打てる。
		if (this.getText() === "") this.#vim.mode = "insert";
		else this.#moveTo(this.#vim.clamp(this.#buffer()));
	}

	/**
	 * 左右の矢印キーでカーソルを target へ運ぶ。Pi の左右は行をまたぐので、これだけで全域に届く。
	 * 上下は使わない。先頭の表示行での上は入力履歴に入り、本文を置き換えてしまう。
	 * 進まなくなるか行き過ぎたら止める (Pi は paste マーカーを 1 文字として飛び越える)。
	 */
	#moveTo(target: Position): void {
		let at = this.getCursor();
		// 1 回で最低 1 文字か改行 1 つは進むので、全文の長さを超えて回ることは無い。
		for (let budget = this.getText().length; budget > 0 && compare(at, target) !== 0; budget--) {
			const side = compare(at, target);
			// 別の行にいる間は行の端へ跳んでからまたぐ。Pi は 1 歩ごとに全文の折り返しを計算し直すので、
			// 1 文字ずつ歩くと setText() のあと (カーソルは文末) の戻りが全文の長さの 2 乗で遅くなる。
			if (at.line !== target.line) super.handleInput(side < 0 ? END : HOME);
			super.handleInput(side < 0 ? RIGHT : LEFT);
			const now = this.getCursor();
			if (compare(now, at) === 0 || compare(now, target) === -side) return;
			at = now;
		}
	}
}

export default function (pi: ExtensionAPI) {
	let generation = 0;
	let activeEditor: VimEditor | undefined;
	pi.on("session_shutdown", () => {
		generation++;
		activeEditor = undefined;
	});
	const restoreEditor = (ctx: ExtensionContext, afterReload = false) => {
		const currentGeneration = ++generation;
		const sessionId = ctx.sessionManager.getSessionId();
		let draft: Draft | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== DRAFT_ENTRY) continue;
			const saved = readDraft(entry.data);
			if (saved !== undefined) draft = saved ?? undefined;
		}
		const restoreRequested = afterReload && draft !== undefined;
		let expandedText: string | undefined;
		try {
			expandedText = ctx.ui.getEditorText();
		} catch {
			// UI がまだ入力欄を作っていない場合は Pi の初期値を使う。
		}
		const host: Host = {
			isActive: (editor) => {
				try {
					if (generation !== currentGeneration || activeEditor !== editor || ctx.sessionManager.getSessionId() !== sessionId) return false;
					ctx.isIdle(); // /reload で無効になった ctx も検出する。
					return true;
				} catch {
					return false;
				}
			},
			saveDraft: (saved) => pi.appendEntry(DRAFT_ENTRY, { version: 1, text: saved?.text ?? null }),
			// セッションの切り替えや /reload のあと、古い ctx は触ると例外を投げる。次の session_start / session_tree で
			// エディタごと作り直されるまでの間は、中断キーが残る側 (応答中扱い) に倒す。
			isIdle: () => {
				try {
					return ctx.isIdle();
				} catch {
					return false;
				}
			},
			warn: (message) => ctx.ui.notify(message, "warning"),
			setDraftStatus: (message) => ctx.ui.setStatus("vim-draft", message),
		};
		ctx.ui.setEditorComponent((tui, theme, kb) => {
			activeEditor = new VimEditor(host, draft, restoreRequested, tui, theme, kb);
			return activeEditor;
		});
		// Pi の交換処理は getText() だけをコピーするため、paste の展開済み本文を後から戻す。
		if (expandedText !== undefined) ctx.ui.setEditorText(expandedText);
		host.setDraftStatus(draft ? "Draft saved" : undefined);
	};
	pi.on("session_start", (event, ctx) => restoreEditor(ctx, event.reason === "reload"));
	pi.on("session_tree", (_event, ctx) => restoreEditor(ctx));
}
