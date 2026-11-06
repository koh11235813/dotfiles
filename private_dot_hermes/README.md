# Hermes: PLaMo 翻訳の試験（issue #68）

Hermes が英語で生成した最終回答を、ローカルの `pfnet/plamo-3-translate-0.8b-GGUF` で日本語に訳す。通常時は日本語だけを表示する（案 B）。Claude / Codex / opencode / Gemini / Pi の設定は変更しない。

## 起動

1. `llama-server` が必要。動作確認したのは Homebrew llama.cpp 0.8.0 / build 11960。モデルは PLaMo Community License。用途に応じて公式ライセンスを確認する。
2. 別ターミナルで次を実行する。初回は公式 GGUF をダウンロードする。localhost 以外には公開しない。launchd への登録は行わない。

   ```sh
   llama-server \
     --hf-repo pfnet/plamo-3-translate-0.8b-GGUF \
     --hf-file plamo-3-translate-0.8b-Q4_K_M.gguf \
     -c 16384 --host 127.0.0.1 --port 8000 \
     --alias plamo-3-translate --jinja --no-prefill-assistant
   ```

3. `curl --fail http://127.0.0.1:8000/health` で `{"status":"ok"}` を確認する。
4. ユーザー自身で dotfiles を適用する。英語版の正本は `private_dot_hermes/custom-roll/ereshkigal.md`、共有の日本語版は `dot_agents/custom-roll/ereshkigal.md` のまま。登録処理は既定の Hermes home のみを対象にする。
5. 適用時の登録スクリプトが `plamo-translate` を有効化してから英語版 roll を選択する。`hermes plugins list` で確認し、新しい Hermes CLI を起動する。既存セッションの system prompt は切り替えない。gateway も同じプロファイルを使う場合、再起動後はこの plugin が適用される点に注意する。

適用前でもリポジトリから `python3 -B private_dot_hermes/tests/smoke_plamo.py` で実翻訳を試せる。これは固定の英語試験文を翻訳するだけで、メインモデルによる生成や Hermes UI の E2E テストではない。

## 挙動と制限

- native plugin の `transform_llm_output` を `hold_stream=True` で登録する。完成した最終回答を翻訳するので、英語の逐次表示はしない。途中の commentary も抑制される。ツール UI の質問・選択肢は翻訳しない。
- Hermes は変換後の日本語を会話履歴にも保存する。表示だけが変わり履歴は英語、という Claude MessageDisplay の方式とは異なる。
- fenced code、4-space/tab のインデント行、inline code、裸の HTTP(S) URL、絶対パスと `./` / `../` で始まるパスを保護する。識別子・相対ファイル名・エラー文は英語版 roll の指示どおりバッククォートで囲む必要がある。任意の Markdown 構文や裸の識別子すべてを解析するものではない。
- `<|plamo:` を含む特殊トークンと保護マーカー自体もマスクする。マーカーが欠落・重複した訳は採用しない。日本語を含む段落は再翻訳しない。
- 段落単位、長い段落は保護処理後の最大 1,600 文字で空白位置を使って分割する。文字数はトークン数の保証ではない。分割できない長い文字列は原文へ戻す。
- 接続失敗、不正応答、生成打ち切り、保護失敗では回答全体を英語の原文に戻す。部分的な訳は残さない。障害時だけは B の「日本語のみ」より回答を失わないことを優先する。
- 翻訳の時間予算は回答全体で 20 秒。Hermes の `plugins.hook_callback_timeout` はこれより余裕を持たせる（既定 30 秒で試験）。Hermes 側の timeout / plugin 自体の異常では、原文復帰ではなく reply-withheld 通知になることがある。
- 送信先は HTTP の `127.0.0.1` / `::1` に限定。HTTP proxy と redirect は利用しない。ログには時間・失敗種別のみを記録し、本文は記録しない。
- Claude 用 gist と違ってストリーミングの断片を処理しないため、段落間・ターン間の翻訳履歴、ファイルロック、slot 固定は持たない。安定した基本動作の確認を先に行い、履歴を使う語調の統一・KV cache 改善は必要になった時点で検討する。
- 別の `transform_llm_output` plugin と自動合成はしない。Hermes は最初に非空文字列を返す transform を採用するので、試験中は競合する transform を有効にしない。

## 口調の比較

`form` の既定値は未指定。通常口調と敬体の切り替えを一律に潰さないため、`plain` / `polite` を強制しない。ただしキャラクターの口調が保存される保証はない。

試験用の任意設定は Hermes CLI で変更する（設定後は新しいプロセスで試す）。

```sh
hermes config set plugins.entries.plamo-translate.settings.form plain
hermes config set plugins.entries.plamo-translate.settings.context 'The speaker is Ereshkigal, a conscientious goddess. She addresses the listener as マスター, is reserved in ordinary conversation, and speaks formally when warning about danger. Preserve this contrast.'
```

`context` は PLaMo の翻訳用文脈であり、汎用モデルの system prompt と同じ指示追従を保証しない。完全な custom-roll を自動転送しない。

固定試験文については以下で `form` と `context` の差と所要時間を JSON 出力できる。

```sh
python3 -B private_dot_hermes/tests/smoke_plamo.py
python3 -B private_dot_hermes/tests/smoke_plamo.py --form plain
python3 -B private_dot_hermes/tests/smoke_plamo.py --form polite
python3 -B private_dot_hermes/tests/smoke_plamo.py --context 'The speaker is a reserved goddess who becomes formal when warning about danger.'
```

最終的な採否は、同じメインモデル・同じユーザープロンプトの新規セッションで、次の 2 条件を比べる。

1. 翻訳 plugin 無効 + 共有の日本語版 roll。
2. 翻訳 plugin 有効 + Hermes 専用の英語版 roll。

プロンプト例: 「最初に私のテスト成功を照れながら褒め、その後、危険な削除操作を止める警告に切り替えて。ツールは使わないで」。一人称・二人称、語尾、同じ回答の中で敬体に変わるかを確認する。固定文 smoke だけではこの比較を済ませたことにならない。

残す選択肢: 中立な訳を受け入れる / 2B と比較する / context を調整する / 日本語の直接生成に戻す。いずれも現時点でキャラ表現の改善を保証しない。

## 日本語の直接生成へ戻す

plugin だけ無効にすると英語版 roll が残るので、両方を戻す。

```sh
hermes plugins disable plamo-translate
python3 - <<'PY'
import json
import subprocess
from pathlib import Path
text = (Path.home() / '.agents/custom-roll/ereshkigal.md').read_text().rstrip('\n')
subprocess.run(['hermes', 'config', 'set', 'personalities.custom-roll',
                json.dumps({'system_prompt': text}, ensure_ascii=False)], check=True)
subprocess.run(['hermes', 'config', 'set', 'display.personality', 'custom-roll'], check=True)
PY
```

新しい Hermes プロセスで確認する。サーバは起動したターミナルで Ctrl-C。英語版ファイルや登録テンプレートが変更された後の chezmoi 適用では英語版が再登録される。変更なしの適用では手動の personality 選択と plugin の無効化を維持する。

## 開発時の検証

```sh
python3 -B -m unittest discover -s private_dot_hermes/tests -v
hermes plugins doctor private_dot_hermes/plugins/plamo-translate --ci
hermes plugins validate private_dot_hermes/plugins/plamo-translate
```

`test_custom_roll.py` は scratch home への実際の chezmoi 適用・Hermes CLI の読み戻しで確認する。翻訳テストはローカル HTTP fixture、`smoke_plamo.py` は本物の翻訳サーバを使う。実 home への適用は検証手順に含めない。

参考: https://github.com/koh11235813/dotfiles/issues/68 、https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/ 、https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF
