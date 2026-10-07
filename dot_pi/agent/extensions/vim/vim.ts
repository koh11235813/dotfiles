/**
 * vim の規則。入出力は index.ts、ここは「どのキーで何が起きるか」だけを持つ。
 *
 * Pi にも端末にも触らない。バッファ (行の配列とカーソル) とキーを受け取り、起こすべきことを
 * Outcome で返す。バッファは毎回もらい直すので、Pi 側で何が起きていても次のキーで追いつく。
 *
 * 位置は書記素の番号で数える。Pi の左右キーは書記素単位で動くので、UTF-16 の途中を指す
 * 位置を返すと index.ts がそこへカーソルを運べない。外に出すときだけ UTF-16 の列に直す。
 *
 * 持たないもの: visual モード、`.`、`f` `t`、検索、名前つきレジスタ、redo。visual は選択範囲の
 * 描画に Pi の非公開メンバーが要るので入れていない。
 */

export type Mode = "insert" | "normal";

/** col は UTF-16 単位。Pi の getCursor() と同じ数え方。 */
export interface Position {
	line: number;
	col: number;
}

export interface Buffer extends Position {
	lines: string[];
	/** 全文の置き換えができない状態。削除系 (x d c D C) を断る。挿入と貼り付けは通す。 */
	frozen?: boolean;
}

/** 何も入っていなければ、キーを飲み込んだだけ。適用は text → insert → cursor → pass の順。 */
export interface Outcome {
	/** 全文をこれに置き換える (削除系)。 */
	text?: string;
	/** at に text を差し込む (o O p P)。全文の置き換えと違い frozen でも使える。 */
	insert?: { at: Position; text: string };
	/** 編集のあとにカーソルを置く位置。 */
	cursor?: Position;
	/** Pi に任せる操作。up / down は入力履歴、undo は Pi の undo。 */
	pass?: "undo" | "up" | "down";
	/** frozen なので断った。 */
	refused?: boolean;
}

/** press に渡す Esc。制御文字なので印字可能なキーと衝突しない。 */
export const ESC = "\x1b";

/** これを超える回数は打ち間違いとみなして丸める。`99999p` で固まらないようにする。 */
const MAX_COUNT = 9999;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), (part) => part.segment);

/** 行内の位置。i が行の書記素数に等しいときは行末の空き (改行のある場所) を指す。 */
interface Slot {
	line: number;
	i: number;
}

type Rows = string[][];
type Operator = "d" | "c" | "y";
type CharClass = "space" | "word" | "hiragana" | "katakana" | "han" | "other";

/**
 * `w` `b` `e` が切れ目にする文字種。日本語は空白で区切らないので、文字種が変わる所を語の境界にする。
 * 長音符 `ー` は Unicode では Common だが、片仮名にしないと「サーバー」が 4 語に割れる。
 */
function classOf(grapheme: string | undefined): CharClass {
	if (grapheme === undefined || /^\s/u.test(grapheme)) return "space";
	if (/^\p{sc=Hiragana}/u.test(grapheme)) return "hiragana";
	if (/^[\p{sc=Katakana}ー]/u.test(grapheme)) return "katakana";
	if (/^\p{sc=Han}/u.test(grapheme)) return "han";
	if (/^[\p{L}\p{N}_]/u.test(grapheme)) return "word";
	return "other";
}

/** 行末の空きは undefined なので space になる。語の走査で改行を空白として扱える。 */
const classAt = (rows: Rows, at: Slot): CharClass => classOf(rows[at.line]![at.i]);

const isEmptyLine = (rows: Rows, at: Slot): boolean => rows[at.line]!.length === 0;

/** 行末の空きを通って次の行へ渡る。バッファの終わりでは undefined。 */
function next(rows: Rows, at: Slot): Slot | undefined {
	if (at.i < rows[at.line]!.length) return { line: at.line, i: at.i + 1 };
	return at.line < rows.length - 1 ? { line: at.line + 1, i: 0 } : undefined;
}

function prev(rows: Rows, at: Slot): Slot | undefined {
	if (at.i > 0) return { line: at.line, i: at.i - 1 };
	return at.line > 0 ? { line: at.line - 1, i: rows[at.line - 1]!.length } : undefined;
}

const before = (a: Slot, b: Slot): boolean => a.line < b.line || (a.line === b.line && a.i < b.i);

const colOf = (row: string[], i: number): number => row.slice(0, i).join("").length;

const position = (rows: Rows, at: Slot): Position => ({ line: at.line, col: colOf(rows[at.line]!, at.i) });

/** normal モードでカーソルが載れる最後の書記素。空行では 0。 */
const lastIndex = (row: string[]): number => Math.max(0, row.length - 1);

/** 空白だけの行では vim と同じく最後の文字。 */
function firstNonBlank(row: string[]): number {
	const i = row.findIndex((grapheme) => classOf(grapheme) !== "space");
	return i < 0 ? lastIndex(row) : i;
}

/** col を含む書記素。書記素の途中 (Pi が 1 文字として扱う paste マーカーの中など) はその頭に寄せる。 */
function slotAt(rows: Rows, at: Position): Slot {
	const line = Math.min(Math.max(at.line, 0), rows.length - 1);
	const row = rows[line]!;
	let col = 0;
	for (let i = 0; i < row.length; i++) {
		col += row[i]!.length;
		if (col > at.col) return { line, i };
	}
	return { line, i: row.length };
}

/**
 * `w`。今いる語を抜け、空白を飛ばして次の語の頭へ。空行は語として止まる。
 * バッファの終わりでは最終行の行末の空きを返す。カーソルに使う側が最後の文字へ丸める。
 * stopAtLineEnd はオペレータつきの最後の 1 回用。行の最後の語で `dw` しても改行を消さない。
 */
function wordForward(rows: Rows, from: Slot, stopAtLineEnd: boolean): Slot {
	let at = from;
	const start = classAt(rows, at);
	// 行末の空きが space なので、語を抜けるループは必ず行内で止まる。
	if (start !== "space") while (classAt(rows, at) === start) at = next(rows, at)!;
	while (classAt(rows, at) === "space") {
		const atLineEnd = at.i === rows[at.line]!.length;
		// 出発点の空行で止まると、空行から動けなくなる。
		if (atLineEnd && isEmptyLine(rows, at) && at !== from) return at;
		if (atLineEnd && stopAtLineEnd) return at;
		const following = next(rows, at);
		if (!following) return at;
		at = following;
	}
	return at;
}

/** 語の最後の文字にいるか。 */
function endsWord(rows: Rows, at: Slot): boolean {
	const here = classAt(rows, at);
	return here !== "space" && classAt(rows, { line: at.line, i: at.i + 1 }) !== here;
}

/**
 * `e`。次の語尾へ。空行では止まらない。先に語尾が無ければ動かない。
 * stay は `cw` 用。すでに語尾にいるなら動かない (1 文字の語で `cw` が次の語まで食わないように)。
 */
function wordEnd(rows: Rows, from: Slot, stay: boolean): Slot {
	let at = from;
	if (!(stay && endsWord(rows, at))) at = next(rows, at) ?? at;
	while (classAt(rows, at) === "space") {
		const following = next(rows, at);
		if (!following) return from;
		at = following;
	}
	while (!endsWord(rows, at)) at = next(rows, at)!;
	return at;
}

/** `b`。前の語の頭へ。空行は語として止まる。 */
function wordBackward(rows: Rows, from: Slot): Slot {
	let at = prev(rows, from);
	if (!at) return from;
	while (classAt(rows, at) === "space") {
		if (isEmptyLine(rows, at)) return at;
		const preceding = prev(rows, at);
		if (!preceding) return at;
		at = preceding;
	}
	for (;;) {
		const preceding = prev(rows, at);
		if (!preceding || classAt(rows, preceding) !== classAt(rows, at)) return at;
		at = preceding;
	}
}

interface Motion {
	to: Slot;
	/** オペレータが to の文字まで含める (`e`)。 */
	inclusive?: boolean;
	/** オペレータが行単位で働く (`j` `k` `gg` `G`)。 */
	linewise?: boolean;
}

export class Vim {
	mode: Mode = "insert";

	private count = "";
	private operator: Operator | undefined;
	/** オペレータのあとに打った回数。`2d3w` は 6 語。 */
	private operatorCount = "";
	private g = false;
	private register: { text: string; linewise: boolean } | undefined;
	/** `j` `k` が戻りたい列。短い行を通っても元の列を覚えておく。line と i は覚えた時のカーソル。 */
	private sticky: { line: number; i: number; want: number } | undefined;

	/** 打ちかけのキー (`d2`、`3`、`g`)。モード表示に出す。 */
	get pending(): string {
		return `${this.count}${this.operator ?? ""}${this.operatorCount}${this.g ? "g" : ""}`;
	}

	/** normal モードのカーソルは行の最後の文字より右に載れない。Pi が動かしたあとの丸め先。 */
	clamp(buffer: Buffer): Position {
		const rows = buffer.lines.map(graphemes);
		const at = slotAt(rows, buffer);
		return position(rows, { line: at.line, i: Math.min(at.i, lastIndex(rows[at.line]!)) });
	}

	/** key は印字可能な書記素 1 つか ESC。insert モードでは ESC だけを見る。 */
	press(key: string, buffer: Buffer): Outcome {
		const rows = buffer.lines.map(graphemes);
		const at = slotAt(rows, buffer);
		if (this.mode === "insert") {
			if (key !== ESC) return {};
			this.mode = "normal";
			return { cursor: position(rows, { line: at.line, i: Math.max(0, at.i - 1) }) };
		}
		if (key === ESC) return this.clear();
		return this.normal(key, rows, { line: at.line, i: Math.min(at.i, lastIndex(rows[at.line]!)) }, buffer.frozen ?? false);
	}

	/** 打ちかけを捨てる。合わないキーが来たときもここを通り、そのキーは飲み込む。 */
	private clear(): Outcome {
		this.count = "";
		this.operator = undefined;
		this.operatorCount = "";
		this.g = false;
		return {};
	}

	private normal(key: string, rows: Rows, cursor: Slot, frozen: boolean): Outcome {
		if (this.g) {
			if (key !== "g") return this.clear();
			key = "gg";
		} else if (key === "g") {
			this.g = true;
			return {};
		} else if (/^[1-9]$/.test(key) || (key === "0" && (this.operator ? this.operatorCount : this.count) !== "")) {
			// `0` は回数を打っている途中だけ数字。そうでなければ行頭への移動。
			if (this.operator) this.operatorCount += key;
			else this.count += key;
			return {};
		}

		const counted = this.count !== "" || this.operatorCount !== "";
		const count = Math.min(Number(this.count || 1) * Number(this.operatorCount || 1), MAX_COUNT);
		const operator = this.operator;
		const row = rows[cursor.line]!;

		if (key === "d" || key === "c" || key === "y") {
			if (!operator) {
				// 動きを待たずに断る。`d` を打った時点で、消せないことが分かるほうが親切。
				if (frozen && key !== "y") return { ...this.clear(), refused: true };
				this.operator = key;
				return {};
			}
			this.clear();
			if (operator !== key) return {};
			return this.operateLines(key, rows, cursor, cursor.line, Math.min(cursor.line + count - 1, rows.length - 1));
		}

		this.clear();
		const sticky = this.sticky;
		this.sticky = undefined;

		if (operator) {
			const motion = this.motion(key, rows, cursor, count, counted, operator);
			return motion ? this.operate(operator, rows, cursor, motion) : {};
		}

		switch (key) {
			case "x":
			case "D":
			case "C": {
				if (frozen) return { refused: true };
				const implied = key === "C" ? "c" : "d";
				const motion = this.motion(key === "x" ? "l" : "$", rows, cursor, count, counted, implied);
				return motion ? this.operate(implied, rows, cursor, motion) : {};
			}
			case "i":
				this.mode = "insert";
				return { cursor: position(rows, cursor) };
			case "a":
				this.mode = "insert";
				return { cursor: position(rows, { line: cursor.line, i: Math.min(cursor.i + 1, row.length) }) };
			case "I":
				this.mode = "insert";
				return { cursor: position(rows, { line: cursor.line, i: firstNonBlank(row) }) };
			case "A":
				this.mode = "insert";
				return { cursor: position(rows, { line: cursor.line, i: row.length }) };
			case "o":
				this.mode = "insert";
				return {
					insert: { at: position(rows, { line: cursor.line, i: row.length }), text: "\n" },
					cursor: { line: cursor.line + 1, col: 0 },
				};
			case "O":
				this.mode = "insert";
				return { insert: { at: { line: cursor.line, col: 0 }, text: "\n" }, cursor: { line: cursor.line, col: 0 } };
			case "p":
			case "P":
				return this.paste(key, rows, cursor, count);
			case "u":
				return { pass: "undo" };
			case "k":
				// 端の行では Pi に渡す。Pi は上下キーで入力履歴をたどる。
				if (cursor.line === 0) return { pass: "up" };
				break;
			case "j":
				if (cursor.line === rows.length - 1) return { pass: "down" };
				break;
		}

		if (key === "j" || key === "k") {
			// Pi の矢印キーなどで動いたあとなら、覚えた列は捨てる。
			const want = sticky && sticky.line === cursor.line && sticky.i === cursor.i ? sticky.want : cursor.i;
			const line = Math.min(Math.max(cursor.line + (key === "j" ? count : -count), 0), rows.length - 1);
			const i = Math.min(want, lastIndex(rows[line]!));
			this.sticky = { line, i, want };
			return { cursor: position(rows, { line, i }) };
		}

		const motion = this.motion(key, rows, cursor, count, counted, undefined);
		if (!motion) return {};
		const to = { line: motion.to.line, i: Math.min(motion.to.i, lastIndex(rows[motion.to.line]!)) };
		// `$` のあとの `j` `k` は行末に張りつく。
		if (key === "$") this.sticky = { ...to, want: Number.POSITIVE_INFINITY };
		return { cursor: position(rows, to) };
	}

	/**
	 * key の行き先。動けない、または動きでないキーなら undefined。
	 * オペレータつきでは行末の空きまで届く (`dl` で最後の文字が消せる、`d$` が行末まで消す)。
	 */
	private motion(
		key: string,
		rows: Rows,
		cursor: Slot,
		count: number,
		counted: boolean,
		operator: Operator | undefined,
	): Motion | undefined {
		const { line, i } = cursor;
		const row = rows[line]!;
		const last = rows.length - 1;
		switch (key) {
			case "h":
				return i > 0 ? { to: { line, i: Math.max(0, i - count) } } : undefined;
			case "l": {
				const limit = operator ? row.length : row.length - 1;
				return i < limit ? { to: { line, i: Math.min(i + count, limit) } } : undefined;
			}
			case "0":
				return { to: { line, i: 0 } };
			case "^":
				return { to: { line, i: firstNonBlank(row) } };
			case "$": {
				const target = Math.min(line + count - 1, last);
				return { to: { line: target, i: rows[target]!.length } };
			}
			case "w": {
				// `cw` は語のあとの空白を残す。vim の歴史的な例外で、語の上では `ce` と同じ。
				if (operator === "c" && classAt(rows, cursor) !== "space") return this.wordEnds(rows, cursor, count, true);
				let to = cursor;
				for (let n = 1; n <= count; n++) to = wordForward(rows, to, operator !== undefined && n === count);
				return { to };
			}
			case "e":
				return this.wordEnds(rows, cursor, count, false);
			case "b": {
				let to = cursor;
				for (let n = 0; n < count; n++) to = wordBackward(rows, to);
				return { to };
			}
			case "j":
			case "k": {
				const target = Math.min(Math.max(line + (key === "j" ? count : -count), 0), last);
				return target === line ? undefined : { to: { line: target, i: 0 }, linewise: true };
			}
			case "gg":
			case "G": {
				const target = counted ? Math.min(count - 1, last) : key === "G" ? last : 0;
				return { to: { line: target, i: firstNonBlank(rows[target]!) }, linewise: true };
			}
			default:
				return undefined;
		}
	}

	private wordEnds(rows: Rows, cursor: Slot, count: number, stay: boolean): Motion {
		let to = cursor;
		for (let n = 0; n < count; n++) to = wordEnd(rows, to, stay && n === 0);
		return { to, inclusive: true };
	}

	private operate(operator: Operator, rows: Rows, cursor: Slot, motion: Motion): Outcome {
		if (motion.linewise) {
			return this.operateLines(
				operator,
				rows,
				cursor,
				Math.min(cursor.line, motion.to.line),
				Math.max(cursor.line, motion.to.line),
			);
		}
		const target = motion.inclusive
			? { line: motion.to.line, i: Math.min(motion.to.i + 1, rows[motion.to.line]!.length) }
			: motion.to;
		const [from, to] = before(target, cursor) ? [target, cursor] : [cursor, target];
		const lines = rows.map((row) => row.join(""));
		const head = rows[from.line]!.slice(0, from.i).join("");
		const tail = rows[to.line]!.slice(to.i).join("");
		const taken =
			from.line === to.line
				? rows[from.line]!.slice(from.i, to.i).join("")
				: [
						rows[from.line]!.slice(from.i).join(""),
						...lines.slice(from.line + 1, to.line),
						rows[to.line]!.slice(0, to.i).join(""),
					].join("\n");
		if (taken === "") {
			// 空行の `c$` や `cw` は何も消さないが、vim と同じく insert には入る。
			if (operator === "c") this.mode = "insert";
			return {};
		}
		this.register = { text: taken, linewise: false };
		if (operator === "y") return { cursor: position(rows, from) };

		const text = [...lines.slice(0, from.line), head + tail, ...lines.slice(to.line + 1)].join("\n");
		if (operator === "c") {
			this.mode = "insert";
			return { text, cursor: { line: from.line, col: head.length } };
		}
		// つないだ行は書記素の切れ目が変わりうる (結合文字が前の文字に付く) ので数え直す。
		const joined = graphemes(head + tail);
		return { text, cursor: { line: from.line, col: colOf(joined, Math.min(from.i, lastIndex(joined))) } };
	}

	/** first 行から last 行までを行ごと扱う (`dd` `cc` `yy` と、`j` `k` `gg` `G` つきのオペレータ)。 */
	private operateLines(operator: Operator, rows: Rows, cursor: Slot, first: number, last: number): Outcome {
		const lines = rows.map((row) => row.join(""));
		this.register = { text: lines.slice(first, last + 1).join("\n"), linewise: true };
		if (operator === "y") {
			return { cursor: position(rows, { line: first, i: Math.min(cursor.i, lastIndex(rows[first]!)) }) };
		}
		if (operator === "c") {
			// 行そのものは残す。消すと、最終行の `cc` で打ち始める行が無くなる。
			this.mode = "insert";
			return {
				text: [...lines.slice(0, first), "", ...lines.slice(last + 1)].join("\n"),
				cursor: { line: first, col: 0 },
			};
		}
		const rest = [...lines.slice(0, first), ...lines.slice(last + 1)];
		// 全部消しても空行が 1 つ残る。行が 0 本のバッファは無い。
		if (rest.length === 0) rest.push("");
		const line = Math.min(first, rest.length - 1);
		const row = graphemes(rest[line]!);
		return { text: rest.join("\n"), cursor: { line, col: colOf(row, firstNonBlank(row)) } };
	}

	private paste(key: "p" | "P", rows: Rows, cursor: Slot, count: number): Outcome {
		const register = this.register;
		if (!register) return {};
		const row = rows[cursor.line]!;
		if (register.linewise) {
			const body = Array<string>(count).fill(register.text).join("\n");
			const first = graphemes(body.split("\n")[0]!);
			const col = colOf(first, firstNonBlank(first));
			return key === "p"
				? {
						insert: { at: position(rows, { line: cursor.line, i: row.length }), text: `\n${body}` },
						cursor: { line: cursor.line + 1, col },
					}
				: { insert: { at: { line: cursor.line, col: 0 }, text: `${body}\n` }, cursor: { line: cursor.line, col } };
		}
		const text = register.text.repeat(count);
		const at = position(rows, { line: cursor.line, i: key === "p" ? Math.min(cursor.i + 1, row.length) : cursor.i });
		// 1 行なら貼った最後の文字、複数行なら貼った先頭に置く (vim と同じ)。
		if (text.includes("\n")) return { insert: { at, text }, cursor: at };
		return { insert: { at, text }, cursor: { line: at.line, col: at.col + text.length - graphemes(text).at(-1)!.length } };
	}
}
