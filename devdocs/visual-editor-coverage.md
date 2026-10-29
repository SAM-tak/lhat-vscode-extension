# 全ASTの表示確認

`tests/graph-language-cases.cjs` は `testing/` 以下の全 `.lh` と、サンプルに不足する構文の補足例を集める。
現行の言語コアの AST 名一覧と実サーバーの応答を照合し、69種類中68種類と拡張側の `disabled` を確認した。
`annotation` は AST 応答にないため、ソースから補ったアノテーションボックスを別に確認する。
補足の `recovery` は構文エラー時の表示用で、正常な構文をUIから作る検証とは別に扱う。

## 再現方法

```powershell
npm run bundle:rf
node --test --test-name-pattern="language AST cases render" tests/graph-svg-browser.test.cjs
```

出力の `AST audit artifacts` にある一時ディレクトリへ、各状態の SVG、補足例3種類の PNG、`coverage.json` を保存する。
各題材は新しいブラウザーで開き、初期の表示設定をそろえる。
通常・全展開・全折りたたみを検証し、展開先がある場合は実際のホイール操作とクリックでドリルダウンして元へ戻る。
空の文書、単純な公開文字列、エラー回復の葉、単位のアノテーションには独立した展開先がない。

## 確認結果

2026-10-30、25題材・96表示状態で以下が通過した。

- ブラウザーの実行時例外がない。
- ノードの座標・寸法と辺の経路が有限で、寸法が負でない。
- SVG が解析でき、表示範囲が正で、矢印の参照先が存在する。
- ソースから補ったアノテーションボックスが表示される。
- コルーチン型、テンプレート・fresh・mutable receiver、単位のアノテーションの PNG を目視し、型ラベル・修飾子・入力欄・接続線の表示を確認した。

各列のノード数は通常 / 全展開 / 全折りたたみの順。

| 題材 | ノード数 | ドリルダウン |
| --- | --- | --- |
| testing/debug-breakpoints.lh | 22 / 22 / 10 | 確認済み |
| testing/debug-fault.lh | 8 / 8 / 7 | 確認済み |
| testing/dispatch.lh | 170 / 492 / 170 | 確認済み |
| testing/empty.lh | 2 / 2 / 2 | 展開先なし |
| testing/enum.lh | 9 / 26 / 9 | 確認済み |
| testing/inventory.lh | 125 / 809 / 125 | 確認済み |
| testing/literals.lh | 58 / 101 / 51 | 確認済み |
| testing/localization.lh | 37 / 53 / 37 | 確認済み |
| testing/loops.lh | 465 / 489 / 34 | 確認済み |
| testing/member-definitions.lh | 17 / 125 / 17 | 確認済み |
| testing/multiple-returns.lh | 248 / 315 / 93 | 確認済み |
| testing/patterns.lh | 41 / 126 / 41 | 確認済み |
| testing/reference-library.lh | 7 / 7 / 7 | 展開先なし |
| testing/references.lh | 29 / 45 / 29 | 確認済み |
| testing/returns.lh | 59 / 109 / 59 | 確認済み |
| testing/zero-based-indices.lh | 1119 / 1200 / 112 | 確認済み |
| values | 57 / 57 / 35 | 確認済み |
| procedure | 15 / 22 / 15 | 確認済み |
| coroutine | 13 / 17 / 13 | 確認済み |
| intersection | 13 / 17 / 13 | 確認済み |
| chain-next | 17 / 17 / 7 | 確認済み |
| callable-tuple-type | 13 / 17 / 13 | 確認済み |
| callable-modifiers | 17 / 37 / 17 | 確認済み |
| recovery | 6 / 6 / 6 | 展開先なし |
| annotation | 7 / 7 / 7 | 展開先なし |

## 最終監査で残る確認

この検証は、各題材を各状態で描画できることと基本的な幾何・SVGの整合性を確認する。
すべてのAST要素について必要な内容が表示されていることを個別に証明するものではない。
各種類の表示方針と、UI作成・内容変更・構造変更・削除の検証との対応を照合し、残る描画内容と構文の細部を確認する。
`visual-editor-unimplemented.md` の最終確認欄は、この照合が完了するまで未完了のままにする。
