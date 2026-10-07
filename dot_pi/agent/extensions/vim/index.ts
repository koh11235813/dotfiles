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

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

interface Host {
	/** エージェントが応答中でないか。 */
	isIdle: () => boolean;
	warn: (message: string) => void;
}

/**
 * 自前のメンバーは `#` つきにしてある。TypeScript の private は実行時にはただのプロパティなので、
 * Pi が将来 Editor に同じ名前を足すと、エラーにならないまま互いの値を上書きする。
 */
class VimEditor extends CustomEditor {
	#vim = new Vim();
	#host: Host;

	constructor(host: Host, ...args: ConstructorParameters<typeof CustomEditor>) {
		super(...args);
		this.#host = host;
	}

	handleInput(data: string): void {
		// Pi は離す側のイベントを普通は届けないが、届くと Esc が 2 回押されたことになる。
		if (isKeyRelease(data)) return;

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
	pi.on("session_start", (_event, ctx) => {
		const host: Host = {
			// セッションの切り替えや /reload のあと、古い ctx は触ると例外を投げる。次の session_start で
			// エディタごと作り直されるまでの間は、中断キーが残る側 (応答中扱い) に倒す。
			isIdle: () => {
				try {
					return ctx.isIdle();
				} catch {
					return false;
				}
			},
			warn: (message) => ctx.ui.notify(message, "warning"),
		};
		ctx.ui.setEditorComponent((tui, theme, kb) => new VimEditor(host, tui, theme, kb));
	});
}
