# subagent

Pi 同梱の公式 sample (`examples/extensions/subagent`) を、いま動いている release から読み込む拡張。
コピーは置かない (サンプル側の修正を取り込み損ねるため)。symlink も置かない (release のバージョンをパスに含むので、Pi を更新すると黙って切れる)。

| ファイル | 中身 |
| --- | --- |
| `index.ts` | sample と、付属の prompt テンプレート (`/implement` など) を読み込む |
| `worktree.ts` | sample の subagent ツールに `worktree` の引数を足す |

## 使い方

ツールの引数と agent の置き場は公式 sample のまま (sample の `README.md`)。足しているのは次の 1 つ。

| 引数 | 中身 |
| --- | --- |
| `worktree: true` | タスクごとに git worktree を作り、子の Pi をその中で起こす。単発は 1 つ、並列はタスクごとに 1 つ、chain は全段で 1 つ |

worktree を作る・子の cwd に渡す・終わった後の差分を結果に足す、のは guard 拡張 (`../guard/README.md` の「subagent の worktree」)。
この拡張がするのは、引数をモデルに見せることと、誰も worktree を用意しなかった呼び出しを止めることだけ。
git を sandbox の中で打てるのが guard だけなので、こう分けている。

## できないこと

- **guard が読み込まれていないと `worktree: true` は使えない。** 子を起こさずにエラーを返す (`subagent: worktree isolation is provided by the guard extension ...`)。黙って共有の cwd で走らせると、分かれているつもりの並列の書き込みが同じ作業ツリーでぶつかる。
- **進捗の表示と並列・chain の書き方は sample のまま。** worktree の場所は進捗には出ない。出るのは終わった後の結果の末尾。
- **統合と削除はしない。** worktree と枝 (`pi-subagent/<id>`) は残る。
- **sample の登録の形に頼っている。** ツール名が `subagent` で、`parameters` が TypeBox の `Type.Object` であること。ツール名が変わると引数は足されない。`parameters` の形が変わると、足した後の引数の表が壊れる。Pi を更新したら、`worktree` がツールの説明に出ているかを 1 度確かめる。

## テスト

```sh
node dot_pi/agent/tests/run.mjs
```

`tests/worktree.test.ts` は sample と同じ形のツールで確かめている。実物の sample は読み込めない (node は `node_modules` の下の `.ts` を実行しない。Pi は jiti で読む)。
