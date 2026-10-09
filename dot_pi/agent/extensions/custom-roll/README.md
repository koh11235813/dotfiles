# Pi custom-roll

セッションごとに口調ファイルをランダムに選び、Pi のプロンプトに適用する extension。
Pi 1.1.0 の `systemPromptOptions.sections` API を使う。
シェルラッパーや `AGENTS.md` の変更は不要。

## 配置と利用方法

chezmoi の管理元と適用先は次のとおり。

| 管理元 | 適用先 |
| --- | --- |
| `dot_pi/agent/extensions/custom-roll/` | `~/.pi/agent/extensions/custom-roll/` |
| `dot_pi/agent/symlink_custom-roll` | `~/.pi/agent/custom-roll` → `~/.agents/custom-roll` |
| `dot_agents/custom-roll/*.md` | `~/.agents/custom-roll/*.md` |

適用後に Pi を起動するか、実行中の Pi で `/reload` する。
自動検出された `index.ts` がイベントハンドラを登録する。
`PI_CODING_AGENT_DIR` が設定されていれば、そのディレクトリ直下の `custom-roll/` を参照する。
標準以外の配置先では、共有ディレクトリへの symlink を別途用意する。

## 選択と保存の設計

`session_start` で、現在のブランチに保存された `custom-roll` entry を探す。
有効な entry がなければ、口調ディレクトリ直下にある通常ファイルの `.md` から、読める非空の本文を候補にする。
`node:crypto.randomInt` で候補を等確率に選び、`pi.appendEntry()` でファイル名と本文を保存する。
別セッションでも、偶然同じ口調が選ばれることはある。

保存するデータは次の形。

```json
{
  "version": 1,
  "name": "ojyo.md",
  "content": "選択した口調ファイルの本文"
}
```

custom entry は会話メッセージではなく、extension 用のセッションデータとして保存される。
ファイル名だけでなく本文も保存するので、元ファイルを変更または削除しても、そのセッションの口調は変わらない。
セッションファイルには口調の全文が残るため、口調ファイルに秘密情報を入れない。

| 操作 | 動作 |
| --- | --- |
| 新規セッション | 候補からランダムに選択して保存 |
| resume / reload | 現在のブランチの保存済み本文を復元 |
| compact | 各ターンのプロンプトに同じ本文を適用 |
| fork | 分岐元の entry が引き継がれれば同じ口調を使う |
| tree 移動 | 移動先ブランチから復元。entry がなければ選択して保存 |
| 導入前のセッション | 初回ロード時に選択して保存 |

毎ターンの `before_agent_start` で、`systemPromptOptions.sections.custom_roll` に本文を設定する。
全プロンプトを置換せず、他のセクションを維持する。
同じセクションを更新するため、ターンごとに本文が重複することもない。
別の extension が `systemPrompt` または `forceSystemPrompt` で全体を置換した場合は、このセクションがモデルに届かないことがある。

候補ディレクトリがない場合、アクセスできない場合、有効な候補がない場合は、口調を注入せず Pi を続行する。
サブディレクトリ内のファイルと、個々のファイルへの symlink は候補にしない。
共有ディレクトリ自体への symlink はたどる。

口調の切替コマンド、状態表示、外部依存は追加しない。
口調ファイルの変更を反映したい場合は新規セッションを開始する。
これはプロンプトへの指示の適用であり、モデルが毎回その口調に従うことを保証するものではない。

## テスト

Node.js 22.18 以降で実行する。
Pi 本体や API キーは不要。

```sh
node --test dot_pi/agent/extensions/custom-roll/tests/custom-roll.test.ts
```

Pi のイベントハンドラをテスト境界とし、一時ディレクトリの口調ファイルとセッションデータを使う。
選択と保存、本文の復元、新規セッションとブランチ移動、繰り返し適用、共有ディレクトリへの symlink、不正な保存値、候補がない場合を検証する。
