# 構文ごとの操作監査

言語コアの `src/ast.c` が列挙する69種類を、以下の編集単位へ対応付ける。
表示の題材は `tests/graph-language-cases.cjs`、UI操作の主な証拠は `tests/graph-svg-browser.test.cjs` にある。表のテスト名は部分一致で検索する。
通常・折りたたみ・ドリルダウンの表示内容と、新規作成・内容変更・構造変更・削除の証拠をこの単位で照合する。個別の最終判定は引き続き未完了。

| AST種類 | UIで扱う単位 | 操作の証拠を調べるブラウザーテスト |
| --- | --- | --- |
| int, float, string | 値の入力、表記の変更、親要素の削除 | ordinary literal inputs / literals sample / localization sample |
| name, ident, hat-ident, focus (it^), scope | 名前値、宣言のリネーム、参照、焦点と距離 | name values and explicit scope / contextual references / quoted declarations |
| interp, interp-text, interp-hole | 文字列の断片と式の穴 | literals sample / with bindings and callback interpolations |
| table, tuple, table-entry | 値の要素、名前・計算キーと対応する値 | computed table keys / nested table patterns / member-definitions sample |
| def, self-table | 定義・インスタンスのフィールドとメソッド | definition members / member-definitions sample / inventory definitions |
| error-new, try | エラー種別・ペイロード、伝播する式 | expression constructors and error kind / multiple-returns sample |
| typeof, type, spread, pack, box | 値を包む式と内側の値 | type queries, boxes and type values / trailing tuple arguments / expression constructors |
| errordef, error-kind, enumdef, enum-member | 名前付き定義と各メンバー | enum sample / member-definitions sample / inventory definitions |
| module, require, require-stmt, import, import-stmt | 単位宣言、読み込みの文・値とパス | reference-library sample / inline module and comment fields / module values import |
| unary, binary, compare-chain, member, index, call, as | 演算子・被演算子、呼び出し先・引数、型 | unary operator context / comparison chains / nil-checked member / type tests and casts |
| func, param | 入出力、引数の名前・型・既定値と本体 | function parameter defaults / mutable receivers and fresh / callable templates |
| define, reassign | 宣言・代入先と値の組、修飾子 | parallel reassignment / deleting a parallel value / member declarations create quoted paths |
| call-stmt | 単独の呼び出し、伝播・フォールバックと文全体 | standalone call menus |
| block | 文の並び、コメント、catch・finally | empty document UI / filtered and catch-all handlers / every loop section |
| if-expr, if-stmt, if-clause | 条件・選択肢と枝、必須のelse | branch menu / pattern structure menu / patterns sample |
| return, break, next, panic | 戻り値、ループの離脱先、panicの値、文全体 | returns sample / nested loop transfers / debug-fault sample |
| yield, await | 送信する値、受信結果、委譲先、phantom、文全体 | yield and await result expressions |
| with | リソースの束縛と本文 | with bindings and callback interpolations / if, callable, with and loop handler menus |
| for, repeat, loop-clause | 焦点、駆動節、更新、範囲、本文と各節 | loops sample / every loop section / a shared for driver |
| type-name, type-func, type-coro, type-apply, type-table, type-tuple, type-union, type-intersect, member-decl | 型注釈全体と各成分、型のメンバー、入出力 | type labels construct / nested tuple, applied and coroutine types / positional counts / typed instance positions |
| annotation | ソースから補う付与先ごとのボックスと各項目 | annotation関連のテスト、`tests/graph-annotations.test.cjs` |
| error | 不正な入力を含むソースの回復表示 | language AST cases render の recovery題材 |

## 削除と構造変更の判定

必須の被演算子や唯一の添字は、それだけを消して不完全な構文にしない。式の差し替え、包んでいる構文の解除、または所有する要素・文の削除を確認する。
`interp-text`・`interp-hole`は補間リスト、`param`・`member-decl`は所属する引数・型のリスト、`if-clause`・`loop-clause`は枝・節の編集を証拠とする。
解析が生成した焦点・比較式は、書かれた焦点やパターンの編集と再解析で対応を確認する。
`annotation`はソースから補った要素を確認する。回復用の`error`は正常な構文を作成する操作の対象にはせず、誤った入力から編集を続けられることを確認する。

## 今回確認した不足と修正

- yield/awaitを式として作成・変更する入口と、phantom yieldの見出し・値リストを修正した。文と式を分け、別の関数・既定引数に中断の候補を出さない。
- 単独の呼び出し文には文として成立する変更だけを提示する。tryとフォールバックの内側でも呼び出しを保ち、呼び出し先・引数は個別に編集する。
- フォールバックで包んだ呼び出しの削除ボタンを表示行に移し、文全体を1個のボタンで削除できるようにした。

残る最終確認は、各行のテストを読み、5種類の操作と3種類の表示状態について何が直接検証され、何が所有する構文を介した検証になるかを記録すること。`visual-editor-unimplemented.md` のチェックは、この照合が終わるまで保留する。
