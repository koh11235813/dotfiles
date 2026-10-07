/**
 * vim.ts の検証。
 *
 * 実行: node --test ~/.pi/agent/extensions/vim/tests/vim.test.ts
 * 依存: node 標準のみ (22.18 以降の型除去で .ts を直接読む)。
 * Pi が読み込むのは index.ts だけなので、このファイルが拡張として動くことはない。
 *
 * index.ts (Pi のエディタへの適用) はここでは見ていない。Outcome を素朴なバッファに当てて、
 * vim.ts が返す内容だけを確かめる。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ESC, graphemes, type Outcome, Vim } from "../vim.ts";

/** Outcome を index.ts と同じ順 (text → insert → cursor → pass) で当てる入力欄の代役。 */
class Session {
	vim = new Vim();
	lines: string[];
	line: number;
	col: number;
	frozen = false;
	passed: string[] = [];
	refused = 0;

	constructor(text: string, line: number, col: number) {
		this.lines = text.split("\n");
		this.line = line;
		this.col = col;
		this.vim.mode = "normal";
	}

	type(keys: string): this {
		for (const key of graphemes(keys)) this.apply(this.vim.press(key, this));
		return this;
	}

	private apply(outcome: Outcome): void {
		if (outcome.refused) this.refused++;
		if (outcome.text !== undefined) this.lines = outcome.text.split("\n");
		if (outcome.insert) {
			const { at, text } = outcome.insert;
			const line = this.lines[at.line]!;
			this.lines.splice(at.line, 1, ...`${line.slice(0, at.col)}${text}${line.slice(at.col)}`.split("\n"));
		}
		if (outcome.cursor) ({ line: this.line, col: this.col } = outcome.cursor);
		if (outcome.pass) this.passed.push(outcome.pass);
	}

	get text(): string {
		return this.lines.join("\n");
	}

	get at(): [number, number] {
		return [this.line, this.col];
	}
}

const start = (text: string, line = 0, col = 0): Session => new Session(text, line, col);

/** keys を 1 つずつ打ち、そのたびのカーソルを集める。 */
const trail = (session: Session, keys: string): [number, number][] =>
	graphemes(keys).map((key) => session.type(key).at);

const JAPANESE = "日本語のテキストをvimで書く。";

test("h と l は行の中だけを動き、最後の文字で止まる", () => {
	const s = start("abc", 0, 1);
	assert.deepEqual(s.type("h").at, [0, 0]);
	assert.deepEqual(s.type("h").at, [0, 0]);
	assert.deepEqual(s.type("2l").at, [0, 2]);
	assert.deepEqual(s.type("l").at, [0, 2]);
	assert.deepEqual(start("ab\ncd", 1, 0).type("h").at, [1, 0]);
});

test("h l x は絵文字や結合文字を 1 文字として扱う", () => {
	// 👍🏽 は UTF-16 で 4 単位、e + 結合アクセントは 2 単位。
	const s = start("a👍🏽béc");
	assert.deepEqual(trail(s, "llll"), [
		[0, 1],
		[0, 5],
		[0, 6],
		[0, 8],
	]);
	assert.deepEqual(trail(s, "hh"), [
		[0, 6],
		[0, 5],
	]);
	assert.equal(start("a👍🏽b", 0, 1).type("x").text, "ab");
	assert.equal(start("aéb", 0, 1).type("x").text, "ab");
});

test("0 ^ $ は行頭、最初の非空白、最後の文字へ動く", () => {
	const s = start("  foo bar", 0, 5);
	assert.deepEqual(s.type("0").at, [0, 0]);
	assert.deepEqual(s.type("$").at, [0, 8]);
	assert.deepEqual(s.type("^").at, [0, 2]);
	assert.deepEqual(start("ab\ncdef").type("2$").at, [1, 3]);
});

test("w は語の頭へ動き、記号を別の語として数える", () => {
	assert.deepEqual(trail(start("foo bar_baz, qux"), "www"), [
		[0, 4],
		[0, 11],
		[0, 13],
	]);
});

test("w b e は日本語の文字種の変わり目で止まる", () => {
	// 日本語 | の | テキスト | を | vim | で | 書 | く | 。
	assert.deepEqual(
		trail(start(JAPANESE), "wwwwwwww").map(([, col]) => col),
		[3, 4, 8, 9, 12, 13, 14, 15],
	);
	assert.deepEqual(
		trail(start(JAPANESE, 0, 15), "bbbbbbbb").map(([, col]) => col),
		[14, 13, 12, 9, 8, 4, 3, 0],
	);
	assert.deepEqual(
		trail(start(JAPANESE), "eeeeeeee").map(([, col]) => col),
		[2, 3, 7, 8, 11, 12, 13, 14],
	);
});

test("長音符は片仮名の語を割らない", () => {
	assert.deepEqual(start("サーバーを立てる").type("w").at, [0, 4]);
});

test("w と b は行をまたぎ、空行で止まる", () => {
	const s = start("foo\n\nbar baz");
	assert.deepEqual(trail(s, "wwww"), [
		[1, 0],
		[2, 0],
		[2, 4],
		[2, 6],
	]);
	assert.deepEqual(trail(s, "bbbb"), [
		[2, 4],
		[2, 0],
		[1, 0],
		[0, 0],
	]);
});

test("e は行をまたぎ、空行では止まらない", () => {
	const s = start("foo\n\nbar baz");
	assert.deepEqual(trail(s, "eeee"), [
		[0, 2],
		[2, 2],
		[2, 6],
		[2, 6],
	]);
});

test("gg G {n}G は行の最初の非空白へ動く", () => {
	const s = start("a\n  b\nc", 1, 2);
	assert.deepEqual(s.type("G").at, [2, 0]);
	assert.deepEqual(s.type("gg").at, [0, 0]);
	assert.deepEqual(s.type("2G").at, [1, 2]);
	assert.deepEqual(s.type("9G").at, [2, 0]);
	assert.deepEqual(s.type("2gg").at, [1, 2]);
});

test("回数は移動にも編集にも掛かり、オペレータの前後の回数は掛け合わせる", () => {
	assert.deepEqual(start("a b c d e").type("3w").at, [0, 6]);
	assert.equal(start("abcdef").type("3x").text, "def");
	assert.equal(start("a b c d e").type("d2w").text, "c d e");
	assert.equal(start("a b c d e").type("2d2w").text, "e");
	assert.equal(start("a\nb\nc\nd", 1).type("2dd").text, "a\nd");
	assert.equal(start("a\nb", 1).type("5dd").text, "a");
});

test("0 は回数の途中なら数字、そうでなければ行頭への移動", () => {
	const s = start("abcdefghijklmnop", 0, 2);
	assert.deepEqual(s.type("10l").at, [0, 12]);
	assert.deepEqual(s.type("0").at, [0, 0]);
	assert.equal(start("abcdef", 0, 3).type("d0").text, "def");
	assert.equal(start("abcdefghijklmnop").type("d10l").text, "klmnop");
});

test("j と k は短い行を通っても元の列に戻る", () => {
	const s = start("abcdef\nab\nabcdef", 0, 4);
	assert.deepEqual(trail(s, "jjkk"), [
		[1, 1],
		[2, 4],
		[1, 1],
		[0, 4],
	]);
	// 途中で横に動いたら、その列が新しい基準になる。
	assert.deepEqual(trail(start("abcdef\nab\nabcdef", 0, 4), "jhj"), [
		[1, 1],
		[1, 0],
		[2, 0],
	]);
	assert.deepEqual(start("ab\nabcdef").type("$j").at, [1, 5]);
});

test("先頭行の k と最終行の j は Pi に渡して入力履歴をたどらせる", () => {
	assert.deepEqual(start("a\nb", 0).type("k").passed, ["up"]);
	assert.deepEqual(start("a\nb", 1).type("j").passed, ["down"]);
	assert.deepEqual(start("a\nb", 1).type("k").passed, []);
	// オペレータの途中では渡さない。動けないので何も消えない。
	const s = start("a\nb", 0).type("dk");
	assert.deepEqual(s.passed, []);
	assert.equal(s.text, "a\nb");
});

test("u は Pi の undo に渡す", () => {
	assert.deepEqual(start("abc").type("u").passed, ["undo"]);
});

test("dd は行を消し、最終行では新しい最終行へ、1 行だけなら空行を残す", () => {
	const first = start("a\nb\nc", 0).type("dd");
	assert.equal(first.text, "b\nc");
	assert.deepEqual(first.at, [0, 0]);
	const middle = start("a\nb\nc", 1).type("dd");
	assert.equal(middle.text, "a\nc");
	assert.deepEqual(middle.at, [1, 0]);
	const last = start("a\n  b\nc", 2).type("dd");
	assert.equal(last.text, "a\n  b");
	assert.deepEqual(last.at, [1, 2]);
	const only = start("abc", 0, 2).type("dd");
	assert.deepEqual(only.lines, [""]);
	assert.deepEqual(only.at, [0, 0]);
});

test("dw は次の語の頭まで、de は語尾まで、d$ と D は行末までを消す", () => {
	const dw = start("foo bar baz", 0, 4).type("dw");
	assert.equal(dw.text, "foo baz");
	assert.deepEqual(dw.at, [0, 4]);
	assert.equal(start("foo bar baz", 0, 4).type("de").text, "foo  baz");
	for (const keys of ["d$", "D"]) {
		const s = start("foo bar baz", 0, 4).type(keys);
		assert.equal(s.text, "foo ", keys);
		assert.deepEqual(s.at, [0, 3], keys);
	}
	assert.equal(start("foo bar baz", 0, 8).type("db").text, "foo baz");
	assert.equal(start("日本語のテキスト", 0, 3).type("dw").text, "日本語テキスト");
});

test("行の最後の語で dw しても次の行とつながらない", () => {
	const s = start("foo bar\nbaz", 0, 4).type("dw");
	assert.equal(s.text, "foo \nbaz");
	assert.deepEqual(s.at, [0, 3]);
	// 回数の途中では行をまたぐ。止まるのは最後の 1 回だけ。
	assert.equal(start("foo bar\nbaz qux", 0, 4).type("d2w").text, "foo qux");
	assert.equal(start("foo bar\nbaz\nqux", 0, 4).type("d2w").text, "foo \nqux");
});

test("dj dgg dG は行ごと消す", () => {
	const dj = start("a\nb\nc\nd", 1).type("dj");
	assert.equal(dj.text, "a\nd");
	assert.deepEqual(dj.at, [1, 0]);
	assert.equal(start("a\nb\nc\nd", 2).type("dk").text, "a\nd");
	assert.equal(start("a\nb\nc\nd", 1).type("dgg").text, "c\nd");
	const dG = start("a\nb\nc\nd", 1).type("dG");
	assert.equal(dG.text, "a");
	assert.deepEqual(dG.at, [0, 0]);
});

test("cw は語のあとの空白を残し、dw は空白ごと消す", () => {
	const cw = start("foo bar").type("cw");
	assert.equal(cw.text, " bar");
	assert.deepEqual(cw.at, [0, 0]);
	assert.equal(cw.vim.mode, "insert");
	const dw = start("foo bar").type("dw");
	assert.equal(dw.text, "bar");
	assert.equal(dw.vim.mode, "normal");
	// 1 文字の語でも次の語まで食わない。
	assert.equal(start("a b").type("cw").text, " b");
	// 空白の上では dw と同じ。
	assert.equal(start("a  b", 0, 1).type("cw").text, "ab");
});

test("c は消した位置で insert に入り、行末でもカーソルを丸めない", () => {
	const s = start("foo bar", 0, 4).type("C");
	assert.equal(s.text, "foo ");
	assert.deepEqual(s.at, [0, 4]);
	assert.equal(s.vim.mode, "insert");
});

test("cc は行を空にして残す", () => {
	const s = start("a\n  b\nc", 1, 2).type("cc");
	assert.equal(s.text, "a\n\nc");
	assert.deepEqual(s.at, [1, 0]);
	assert.equal(s.vim.mode, "insert");
	assert.equal(start("a\nb", 1).type("cc").text, "a\n");
});

test("yy した行は p で下、P で上に行ごと入る", () => {
	const below = start("one\n  two").type("jyyp");
	assert.equal(below.text, "one\n  two\n  two");
	assert.deepEqual(below.at, [2, 2]);
	const above = start("one\ntwo").type("yyjP");
	assert.equal(above.text, "one\none\ntwo");
	assert.deepEqual(above.at, [1, 0]);
	assert.equal(start("a\nb").type("yy2p").text, "a\na\na\nb");
	assert.equal(start("a\nb\nc").type("2yyGp").text, "a\nb\nc\na\nb");
});

test("dd した行も p で貼れる", () => {
	const s = start("a\nb\nc").type("ddp");
	assert.equal(s.text, "b\na\nc");
	assert.deepEqual(s.at, [1, 0]);
});

test("文字単位で取ったものは p でカーソルの後ろ、P でカーソルの位置に入る", () => {
	const after = start("foo bar").type("yw$p");
	assert.equal(after.text, "foo barfoo ");
	assert.deepEqual(after.at, [0, 10]);
	const at = start("foo bar").type("ywP");
	assert.equal(at.text, "foo foo bar");
	assert.deepEqual(at.at, [0, 3]);
	assert.equal(start("ab").type("xp").text, "ba");
	assert.equal(start("").type("p").text, "");
	// 改行を含む文字単位の貼り付けは行を割って入り、カーソルは貼った先頭に残る。
	const split = start("ab cd\nef gh", 0, 3).type("y2wP");
	assert.equal(split.text, "ab cd\nef cd\nef gh");
	assert.deepEqual(split.at, [0, 3]);
});

test("y は後ろ向きの動きでは範囲の頭へカーソルを動かし、文字は消さない", () => {
	const s = start("foo bar", 0, 4).type("yb");
	assert.equal(s.text, "foo bar");
	assert.deepEqual(s.at, [0, 0]);
	assert.equal(s.type("$p").text, "foo barfoo ");
});

test("行末の x は最後の文字を消してカーソルを左へ寄せる", () => {
	const s = start("abc", 0, 2).type("x");
	assert.equal(s.text, "ab");
	assert.deepEqual(s.at, [0, 1]);
	assert.equal(start("").type("x").text, "");
	assert.equal(start("abc", 0, 1).type("9x").text, "a");
});

test("normal モードのカーソルは行の最後の文字より右に載らない", () => {
	const vim = new Vim();
	assert.deepEqual(vim.clamp({ lines: ["abc"], line: 0, col: 3 }), { line: 0, col: 2 });
	assert.deepEqual(vim.clamp({ lines: ["a👍🏽"], line: 0, col: 5 }), { line: 0, col: 1 });
	assert.deepEqual(vim.clamp({ lines: [""], line: 0, col: 0 }), { line: 0, col: 0 });
	// Pi が行末に置いたカーソルも、最後の文字にいるものとして扱う。
	assert.deepEqual(start("abc", 0, 3).type("h").at, [0, 1]);
	assert.equal(start("abc", 0, 3).type("x").text, "ab");
});

test("insert からの Esc はカーソルを 1 文字左へ寄せる", () => {
	const leave = (text: string, col: number): Session => {
		const s = start(text, 0, col);
		s.vim.mode = "insert";
		return s.type(ESC);
	};
	assert.deepEqual(leave("abc", 3).at, [0, 2]);
	assert.deepEqual(leave("abc", 0).at, [0, 0]);
	assert.deepEqual(leave("a👍🏽", 5).at, [0, 1]);
	assert.equal(leave("abc", 3).vim.mode, "normal");
});

test("insert モードでは Esc 以外に反応しない", () => {
	const s = start("abc");
	s.vim.mode = "insert";
	assert.deepEqual(s.vim.press("d", s), {});
	assert.deepEqual(s.vim.press("d", s), {});
	assert.equal(s.vim.mode, "insert");
});

test("i a I A o O は位置を決めて insert に入る", () => {
	for (const [key, at, text] of [
		["i", [0, 3], "  foo"],
		["a", [0, 4], "  foo"],
		["I", [0, 2], "  foo"],
		["A", [0, 5], "  foo"],
		["o", [1, 0], "  foo\n"],
		["O", [0, 0], "\n  foo"],
	] as const) {
		const s = start("  foo", 0, 3).type(key);
		assert.deepEqual(s.at, at, key);
		assert.equal(s.text, text, key);
		assert.equal(s.vim.mode, "insert", key);
	}
	assert.deepEqual(start("").type("a").at, [0, 0]);
	assert.equal(start("a\nb").type("o").text, "a\n\nb");
});

test("打ちかけは合わないキーで消え、そのキーは飲み込まれる", () => {
	const s = start("foo bar");
	// z はオペレータの相手にならない。続く w は d と無関係な移動になる。
	assert.equal(s.type("dzw").text, "foo bar");
	assert.deepEqual(s.at, [0, 4]);
	// 別のオペレータ、g のあとの g 以外、Esc でも消える。
	assert.equal(start("foo bar").type("dcw").text, "foo bar");
	assert.equal(start("a\nb").type("gdd").text, "a\nb");
	assert.equal(start("abc").type(`3${ESC}x`).text, "bc");
	assert.equal(start("a\nb").type(`d${ESC}d`).text, "a\nb");
});

test("打ちかけはモード表示用に読める", () => {
	const s = start("a\nb\nc");
	assert.equal(s.vim.pending, "");
	assert.equal(s.type("2d3").vim.pending, "2d3");
	assert.equal(s.type(ESC).vim.pending, "");
	assert.equal(s.type("dg").vim.pending, "dg");
	assert.equal(s.type("g").vim.pending, "");
});

test("frozen では削除系を断り、移動と yank と貼り付けは通す", () => {
	const s = start("foo bar\nbaz");
	s.frozen = true;
	for (const keys of ["x", "dd", "dw", "cw", "cc", "D", "C"]) s.type(keys);
	assert.equal(s.text, "foo bar\nbaz");
	assert.equal(s.vim.mode, "normal");
	assert.equal(s.vim.pending, "");
	// d と c は 1 打目で断るので、続く d w c は別のキーとして数え直される。
	assert.equal(s.refused, 9);
	assert.deepEqual(s.type("ggw").at, [0, 4]);
	assert.equal(s.type("yyp").text, "foo bar\nfoo bar\nbaz");
	assert.equal(s.type("o").text, "foo bar\nfoo bar\n\nbaz");
});
