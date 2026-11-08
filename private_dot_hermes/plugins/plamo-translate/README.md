# plamo-translate

Hermes が英語版 roll（`~/.hermes/custom-roll/ereshkigal.en.md`）で書いた返答を、エレシュキガルの口調に編集した PLaMo 3 Translate（#68）で日本語にする plugin。

## 有効にする

1. 翻訳器の GGUF を `~/.hermes/plamo/ereshkigal-2b.gguf` に置く（2B の `b18s175-2b-q8_0.gguf` をコピーかリンク）。`llama-server`（Homebrew の llama.cpp など）が PATH に要る。
2. dotfiles を適用する。登録スクリプトが、GGUF のあるホストだけ英語版 roll を選び、この plugin を有効にし、`plugins.hook_callback_timeout` を 180 秒にする。GGUF の無いホストは日本語版 roll のまま、plugin は無効。
3. 新しい Hermes のセッションで使う。

最初の返答のとき、`127.0.0.1:8091` で llama-server が応答しなければ、plugin が GGUF を指定して起動する。起動した llama-server は Hermes を閉じても残る。止めるときは `pkill -f 'llama-server -m .*ereshkigal-2b.gguf'`。

## 訳し方

- 返答全体を1回で訳す。`context` に学習済みの 16 文字のソフトトークンと利用者のメッセージ（`pre_llm_call` で覚えたもの、末尾 2,000 字まで）を入れ、用語集（underworld → 冥界、Master → マスター）を付ける。訳が出力の上限で切れたり、サーバの context に収まらなかったりしたら、段落ごとに訳し直す。
- 真面目に／正確に／厳密に／冗談抜きで／冗談なしで と頼まれた返答の文末が半分以上 敬体 でなければ、`form=polite` で全体を訳し直す。
- それ以外の返答で、"One caution:" や "One more warning" で始まる段落の訳が 常体 なら、その段落だけ `form=polite` で訳し直す。
- コードブロックとバッククォートで囲んだ部分は、数が合えば英語の原文に戻す（翻訳器はコメントやエラー文まで訳すため）。コードの外の「あなた」「あんた」は「アナタ」にする。
- delegate したサブエージェントの返答（`parent_session_id` のある session）は訳さない。英語のまま親のモデルに渡る。
- 接続の失敗、訳せなかったとき、持ち時間を超えたときは、英語の原文をそのまま返す。持ち時間は `budget_seconds`（既定 150 秒）と、Hermes のフックの打ち切り時間（登録スクリプトが 180 秒にする）から 15 秒引いた値の短いほう。打ち切られると Hermes は返答そのものを出さないため。ログに本文は残さない。
- 返答を受け取りきってから訳すので、英語の逐次表示は出ない。Hermes は訳した日本語を会話履歴に保存する。

## 設定

```sh
hermes config set plugins.entries.plamo-translate.settings.model_path ~/models/other.gguf
hermes config set plugins.entries.plamo-translate.settings.base_url http://127.0.0.1:8092
hermes config set plugins.entries.plamo-translate.settings.budget_seconds 120
```

`base_url` はポート付きの HTTP ループバック（`127.0.0.1` か `::1`）だけを受け付ける。`/health` が ok を返すサーバなら何でも翻訳器として使うので、複数人で使うホストでは、別の人が先にそのポートを取ると返答を差し替えられる。一人で使う機械を前提にしている。

## 測った結果（#68）

blind 審査、15 点満点（声・のだわ・自然さ）。日本語版 roll で Hermes が直接書いた日本語と比べて、24 件の保留メッセージで 2B 12.04 対 9.40、技術の質問 22 件で 2B 11.47 対 8.99。技術の訳の忠実さは 8B のほうが高い（4.11 対 3.36、5 点満点）。8B を使うなら `model_path` を差し替える（1 回答 30 秒ほど）。

## ライセンス

GGUF は PLaMo Community License の派生モデル。手元で使うぶんには問題ないが、他人に渡すときは第 4 条の表示が要る。

## 開発時の検証

```sh
python3 -B -m unittest discover -s private_dot_hermes/tests -v
hermes plugins validate private_dot_hermes/plugins/plamo-translate
hermes plugins doctor private_dot_hermes/plugins/plamo-translate --ci
```
