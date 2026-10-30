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

出力の `AST audit artifacts` にある一時ディレクトリへ、各状態の SVG、補足例7種類の PNG、`coverage.json` を保存する。
各題材は新しいブラウザーで開き、初期の表示設定をそろえる。
通常・全展開・全折りたたみを検証し、展開先がある場合は実際のホイール操作とクリックでドリルダウンして元へ戻る。
空の文書、単純な公開文字列、エラー回復の葉、単位のアノテーションには独立した展開先がない。

## 確認結果

2026-10-30、29題材・112表示状態で以下が通過した。

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
| position-types | 13 / 17 / 13 | 確認済み |
| handlers | 51 / 57 / 4 | 確認済み |
| cleanup-transfer | 15 / 70 / 15 | 確認済み |
| quoted-names | 25 / 33 / 25 | 確認済み |
| recovery | 6 / 6 / 6 | 展開先なし |
| annotation | 7 / 7 / 7 | 展開先なし |

## 最終監査で残る確認

この検証は、各題材を各状態で描画できることと基本的な幾何・SVGの整合性を確認する。
すべてのAST要素について必要な内容が表示されていることを個別に証明するものではない。
位置要素・索引型・self節を含む型のPNGでは、引数が「テーブル型」と表示されることを確認した。この短縮は `06-visual-editor.md` の3.3節の表示方針に従う。完全な型をツールチップとメニューに保持することを含め、各型要素の表示内容を引き続き照合する。
`handlers` と `cleanup-transfer` のPNGで、通常経路とcatchの合流後にfinallyが表示されることを確認した。実サーバーのブロック・if・手続き・ループから作ったグラフについて、finallyを除くと後続文への経路がなくなることを `graph-execution.test.cjs` で検証する。ループのcatchは反復内で合流し、finallyはループの後に置く。
途中離脱は通常の続行と混同しない破線で後処理への関係を示す。return・panic・break・next、多重のbreak/next、入れ子のfinallyと別の手続きへの境界を検証した。折りたたんだ内側の離脱はその箱から関係を示し、同じ箱に収まる接続は描かない。
`cleanup transfer ports` のブラウザーテストは折りたたみ・ドリルダウン・再展開後のポートと破線、SVGの破線を確認する。`lhat-finally-transfer.png` と `lhat-finally-transfer-tail.png` を一時ディレクトリへ保存する。空のreturnの入力・後処理用ポートも確認し、表示操作でソースが変わらないことを検証する。
break・nextの構造メニューでは、現在の関数・手続き内のループ段数から離脱先を選ぶ。skip・continueや角括弧の段数表記も編集できる。焦点付き条件分岐は段数に含めず、別のcallableの外には飛ばない。空の文書から二重ループと離脱文を作り、break/next・段数の変更、ラベルの再表示、削除までブラウザーで確認した。
varの宣言先は名前・引用名・メンバーへのパス・明示的なスコープ参照へ変更できる。既存メンバーへの代入許可も切り替え、見出しの`:=`とソースの両方に反映する。型と隣接コメントを保ち、パスをletに変更する候補は出さない。`mutable declarations edit member paths`と`member declarations create quoted paths`の実サーバー・ブラウザーテストで、入力の制約と作成・変更・削除を確認した。
`quoted-names` のPNGで、引用名の宣言入力・メンバー参照・名前値の表示を確認した。空の文書からのUI作成とAST・字句列の一致、引用名→通常名→日本語の引用名への再リネームも検証する。型のメンバー名・修飾型名・catchの選択肢でも同じ引用表記を使う。
引用名のリネームは lhat 本体の `327e092` 以降のLSPを使う。引用された使用箇所と通常表記の宣言が別ファイルにある場合も、各ファイルの実際の綴りの範囲を編集対象にする。C側の定義参照・references・ホバー・シグネチャ・LTONのテストと、実サーバーによる別ファイルのWorkspaceEditを確認した。
自動採番とスコープ内の型候補は、通常名と同じ内容の引用名を同一の名前として扱う。変数・メンバー・焦点・ループ変数の衝突回避と、型名の隠蔽を実サーバーで検証した。
各種類の表示方針と、UI作成・内容変更・構造変更・削除の検証との対応を照合し、残る描画内容と構文の細部を確認する。
`visual-editor-unimplemented.md` の最終確認欄は、この照合が完了するまで未完了のままにする。
