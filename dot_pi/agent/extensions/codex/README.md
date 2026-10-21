# codex

Pi のモデルが Codex に仕事を頼むための 2 つのツール、`codex` と `codex_reply` を足す拡張。
前は MCP サーバー (`codex` / `codex-reply`、codex app-server への bridge) で同じことをしていた。その置き換えで、引数の形までは合わせていない。

どちらのツールも `codex exec --json` を 1 回起こし、最後の答えを返したら終わる (codex-cli 0.164.0-alpha.8 で確かめた)。

しないこと: `/codex-review` のようなコマンド、app-server との常駐の接続、途中経過の中継、`danger-full-access`、承認の取り次ぎ。

## ツール

### `codex`

新しい thread を始める。

| 引数 | 既定 | 意味 |
| --- | --- | --- |
| `prompt` | (必須) | Codex への指示。stdin で渡す |
| `cwd` | Pi の cwd | Codex を起こすディレクトリ。Pi の cwd の中だけ (相対なら Pi の cwd から) |
| `sandbox` | `read-only` | `read-only` か `workspace-write` |
| `model` | Codex の設定のまま | `-m` で渡す |
| `effort` | Codex の設定のまま | `minimal`・`low`・`medium`・`high`・`xhigh`。`-c model_reasoning_effort=` で渡す |

返すのは、最後の `agent_message` の本文と、末尾の `threadId: <id>` の行。結果の `details` は `{ threadId, cwd, sandbox, model, effort }`。

### `codex_reply`

| 引数 | 意味 |
| --- | --- |
| `threadId` | `codex` が返した id |
| `prompt` | 続きの指示 |

その thread を始めたときの `cwd`・`sandbox`・`model`・`effort` を戻して、`codex exec resume` で続ける。設定はモデルに選ばせない。

## 起こし方

```sh
# codex
codex exec --json -c 'sandbox_mode="read-only"' -c 'approval_policy="never"' [-c 'model_reasoning_effort="high"'] [-m <model>] [--skip-git-repo-check] -- -
# codex_reply
codex exec resume --json -c 'sandbox_mode="…"' -c 'approval_policy="never"' [...] -- <threadId> -
```

シェルは通さず argv で起こし (`spawn`)、`cwd` は spawn の cwd で渡す。プロンプトは stdin に書いて閉じる (`-`)。argv に載せると `ps` に見え、長さの上限にも当たる。
stdout の JSONL を行ごとに読み、stderr は別に末尾 4 KiB だけ残す。

成功は、終了コード 0、`turn.completed`、`agent_message` が 1 つ以上、thread id (`thread.started` か、resume なら渡した id) の全部がそろったとき。
`turn.failed` とトップレベルの `error` は失敗。`item.completed` の `error` (非推奨の設定の警告など) と JSON でない行は読み飛ばす。
失敗のときは理由と stderr の末尾を、thread id が分かっていればそれも、エラーに載せる。stderr は成功しても無関係な `ERROR` の行を出すので、判定には使わない。

## 決めたこと

- **sandbox と承認を毎回明示する。** `~/.codex/config.toml` の既定は on-request + workspace-write なので、渡さなければそれを引き継ぐ。`approval_policy="never"` で、承認を求めずに sandbox の中で失敗させる。失敗した後に sandbox を広げて起こし直すことはしない。
- **sandbox は `-s` ではなく `-c sandbox_mode=` で渡す。** `exec resume` は `-s` も `-C` も受け付けない。起こすときと続けるときで同じ形にする。`-c` でも read-only が効くことは、本物の codex に `touch` させて確かめた (`DENIED`、ファイルは作られない)。
- **`danger-full-access` は選ばせない。** 列挙に入れていない。
- **cwd は Pi の cwd の中だけ。** symlink を解いてから比べる。`codex_reply` で戻した cwd も確かめ直す (セッションは別の cwd で開き直せる)。確かめるのは thread の順番が来て起こす直前で、起こすのは symlink を解いた後のパス。並ぶ前に確かめると、待っている間にディレクトリを外への symlink に差し替えられる。
- **thread は id を明示して続ける。** `--last` は使わない。同じ cwd で別の thread が走っていると、違う thread を続ける。`--ephemeral` も使わない。続けられなくなる。
- **thread の設定は 2 か所から引く。** このプロセスで始めた thread は手元の Map から。セッションを開き直した後は、今の枝にある `codex` / `codex_reply` の結果の `details` から (Pi の docs が枝に沿う状態の置き場としているもの)。枝の値は列挙で縛られていないので、知らない `sandbox` や `effort` なら使わない。どちらにも無い id は断る。設定が分からない thread を、こちらの既定の sandbox で続けないため。
- **失敗しても thread id が出ていれば覚える。** timeout や中断の後でも `codex_reply` を断らない。ターンの途中で止めた thread を本物の codex が続けられるかは試していない。
- **同じ thread への `codex_reply` は 1 つずつ。** 1 つのメッセージで並べて呼ばれても、後のものは前のものが終わるのを待つ。`executionMode: "sequential"` にしないのは、それだと他のツールとも直列になるから。
- **`read-only` のときだけ `--skip-git-repo-check` を付ける。** git の確認は取り消せない書き込みから守るためのもので、read-only では書けない。git の外のディレクトリでも読ませて訊けるようにする。`workspace-write` では付けないので、git の外では Codex が断るはず (git の外では試していない)。
- **`readOnlyHint` を付けない。** `workspace-write` では cwd の中を書き換える。guard は自己申告のヒントしか見ないので、guard の `ask` では毎回確認、`readonly` では遮断になる。
- **止めるときはプロセスグループと、別のセッションに出た子孫も。** codex はコマンドを別のセッション (setsid) で起こすので、グループへのシグナルは届かない。`detached` で起こしたグループに加えて、`/bin/ps -A -o pid=,ppid=` の親子を辿って集めた codex の子孫に 1 つずつ SIGTERM を送り、2 秒後に (辿り直した分も足して) SIGKILL を送る。子孫は codex が生きているうちに集める。codex が死ぬと init に付け替えられて辿れない。SIGKILL のタイマーは、codex が TERM ですぐ死んで先に返った後でも走る。`ps` を名前で探さないのは、PATH にモデルが書ける場所があると、そこに置かれた `ps` が Pi の権限で走るから。ツールの中断、timeout、`session_shutdown` の 3 か所。
- **`session_shutdown` の後は起こさない。** 走っているものを止めるだけでは、同じ thread に並んでいた `codex_reply` が、前の 1 つが止まった後に順番が来て起きる。shutdown で立てた印を見て、並んでいたものも cancelled で断る。印は戻さない。shutdown の後、Pi は拡張を読み込み直した別の runtime で続ける (`dist/core/agent-session-runtime.js` の `teardownCurrent`、`agent-session.js` の `reload`)。
- **パイプは返るときに閉じる。** codex が終わっても子がパイプを握っていて `close` が来ないときは、グループに SIGKILL を送って 250 ms だけ待ち、stdin・stdout・stderr を destroy して返る。閉じないと、握っている子孫が居る間ハンドルが残る。
- **出力は上限を決めて持つ。** stderr は末尾 4 KiB、答えは 200,000 文字、改行の来ない stdout の行は 4 MiB で捨てる。

## 環境変数

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `PI_CODEX_TIMEOUT_MS` | `1800000` (30 分) | 1 回の `codex exec` の上限。呼ぶたびに読む |
| `PI_CODEX_BIN` | `codex` (PATH から) | 起こす codex。テストが偽物に向ける |

## なぜ app-server ではなく exec か

- app-server は JSON-RPC の常駐プロセスで、初期化・thread の管理・承認の要求への返事・通知の購読を拡張が持つことになる。前の MCP bridge がそれだった。
- 1 回頼んで答えをもらうだけなら `codex exec --json` で足り、プロセスの寿命がツール呼び出し 1 回と同じになる。止めるのも、プロセスグループを止めるだけ。
- 承認は `never` に固定するので、承認の要求に答える口 (app-server でしかできないこと) が要らない。
- 代わりに失うもの: 途中経過 (コマンドの実行や差分) を Pi に流すこと、thread の一覧や中断の細かい制御。

## できないこと

- **codex が自分で終わった後に残った、別のセッションの子孫は止めない。** 終わった時点で親子の糸が切れていて、見つけられない。止めて辿るのは、こちらから止めるとき (中断・timeout・shutdown) だけ。
- **SIGKILL を送る 2 秒の間に、集めた pid が別のプロセスに使い回されると、そちらに当たる。** 受け入れた。
- **guard の sandbox の外で動く。** guard は他の拡張のツールを sandbox に入れない (`../guard/index.ts` の冒頭)。境界は Codex 自身の sandbox だけ。codex は Pi のプロセスから、Pi と同じ環境変数で起こす。
- **途中経過は出さない。** 答えが出るまでツールは黙っている。長い仕事は timeout (既定 30 分) に当たりうる。
- **Codex の設定の他の値は引き継ぐ。** `model`、`model_provider`、MCP サーバー、hooks などは `~/.codex/config.toml` のまま。上書きするのは sandbox・承認・(指定したときの) model と effort だけ。
- **resume が設定を本当に戻すかは codex 次第。** `-c` と `-m` を毎回渡し直しているが、resume で thread に記録された設定とどちらが勝つかは、`sandbox_mode` 以外は確かめていない。
- 実物の Pi では確かめていない。確かめたのは、偽の Pi (`../../tests/extension-host.ts`) と偽の codex でのテストと、偽の Pi から本物の codex を起こした smoke test (git リポジトリの中で `OK` → resume で `AGAIN`、read-only で `touch` が断られること)。型検査もしていない (このリポジトリに tsc が無い)。

## テスト

```sh
node dot_pi/agent/tests/run.mjs
```

`tests/codex.test.ts` は、`PI_CODEX_BIN` を使い捨てのディレクトリに置いた偽の codex (引数・cwd・stdin・pid を書き、用意した JSONL を出す shell script) に向けて確かめる。本物の codex は起こさない。
