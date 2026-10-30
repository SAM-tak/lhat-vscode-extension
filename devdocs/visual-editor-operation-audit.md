# 構文ごとの操作監査

言語コアの `src/ast.c` が列挙する69種類を、以下の編集単位へ対応付ける。
表示の題材は `tests/graph-language-cases.cjs`、UI操作の主な証拠は `tests/graph-svg-browser.test.cjs` にある。表のテスト名は部分一致で検索する。
通常・折りたたみ・ドリルダウンの表示内容と、新規作成・内容変更・構造変更・削除の証拠をこの単位で照合する。未照合の行が残る。

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
- 補間の文字列断片・穴を個別に削除する操作を追加した。書式と式を持つ穴を消しても隣の文字列・穴を保ち、最後の断片を消しても空の補間文字列から再追加できる。

## 補間の操作と表示の照合

`interpolation text and formatted holes`のブラウザーテストは、空の文書から補間を作成し、文字列・穴の式・書式を変更する。書式付きの計算式の穴と文字列断片を削除し、空になった後に穴と文字列を再追加し、最後に所有する宣言を削除する。各操作で実サーバーからのASTを再表示し、作成時には期待するASTと字句列にも一致する。
`interpolation parts delete independently`の実サーバーテストは、削除で隣り合った文字列断片が正しく結合されることと、入れ子の補間で内側の断片だけを削除できることも確認する。

`literal, name and interpolation contents`のブラウザーテストは、通常表示のSVGに整数の全桁・指数表記・日本語・引用名・単位スコープ参照・補間の文字列と書式が残ることを確認する。折りたたみ時は通常の値と所有する宣言名、補間の短縮表示を確認し、実際のクリックで補間へドリルダウンした後は文字列断片と書式が再び表示されることを確認する。表示操作によるソース変更がないことも検証する。
ドリルダウン先には整数・浮動小数点・通常の文字列・バイトを含む文字列と補間断片も置き、値とエスケープ表記がSVGに残ることを直接確認する。

## 値の表記とバイト値の照合

`string escape menus`のブラウザーテストは、空の文書から通常の文字列を作り、行末形式と引用符形式を往復させ、エスケープ表記からバイト値を作成・再編集・削除する。先頭末尾の空白と空文字も保つ。補間の断片でもバイト値を作成し、通常の文字列へ戻し、空の断片へ変更する。
`string escape editing`・`interpolation text escapes`・`rest-of-line strings`の実サーバーテストは、これらのソースと型、穴の個数、後続の文・コメント・閉じ記号、CRLFの保持を照合する。文字列を閉じる入力と、断片に新しい穴を作る単独の波括弧は候補にしない。ソースにある行の継続と制御文字は、入力欄では同じ値の一行のエスケープ表記にする。

## アノテーションの照合

`Unicode annotations create`は空の文書から関数内の宣言とアノテーションを作り、数値・カンマ入りの文字列の引数、Unicode名への変更、2件目の末尾追加、一覧と所有する関数の折りたたみ、ドリルダウン後のSVG内容、各行の削除と最後のボックスの消滅まで実サーバーとUIで確認する。空のボックスを開く操作と表示切替ではソースを変えない。
`annotation owners exclude header bindings`は単位・宣言・定義のメンバー・selfフィールドそれぞれへの追加と削除、結合文字・絵文字・引用名の引数を再解析して確認する。`for`・`with`のヘッダー内の束縛は、そこへアノテーションを書けないため追加先にしない。アノテーション名は現在の字句規則のUnicode範囲を使い、ハットと引用名は受け付けない。名前と引数の括弧の間に改行がある場合は、括弧をアノテーションに取り込まない。
名前を取る引数を既存の入力欄で編集できることと、数値・文字列・名前の種類をUIから変更できることは別々に照合する。特にカタログから作る既定の文字列引数を名前引数へ変更する入口と、可変長引数の個数の編集は、まだ最終確認が残る。

## 名前・参照の照合

`Unicode names stay editable`と`Unicode declaration names`は、結合文字・絵文字・補助平面の文字を使った宣言名のリネームと参照追従を、実サーバーとUIで確認する。単位・外側スコープ参照、名前値、名前付き焦点のリネーム、`it^`と`it^^`への変更、所有する式や宣言の削除もUIで確認した。名前の字句判定は現在の言語コアと同じ範囲にし、Unicodeの空白と比較・乗算演算子を名前に取り込まない。
`names and focus captions`は通常表示の宣言名、展開後のスコープ・引用名・現在と外側の焦点の見出し、折りたたんだテーブルの名前と短縮表示、ドリルダウン後の同じ見出しをSVGの文字内容で確認する。表示操作でソースを変更しないことも検証する。

`local expressions create anonymous focus values`は空の文書からローカルな値を持つ式を作り、名前の解除・再追加、リネーム、値の変更、型付きの名前の解除・再追加、外側の焦点の追加・解除、式と所有する宣言の削除をUIから行う。型付きの名前なしの値も、名前を付けて値を編集してから再び名前を外せる。`single focus values switch`は条件分岐・パターン分岐・共有ループ駆動部でも切り替えを確認し、型・コメント・本文と名前の衝突回避を照合する。
名前なしの焦点について解析が生成した仮の宣言は描かず、実際の値を一度だけ表示する。仮の宣言の名前入力・宣言先リスト・アノテーション追加は提示しない。`names and focus captions`は通常・展開・ドリルダウンの各表示で値の重複がないことも確認する。実行線と分岐の接続は`implicit match focuses`・`match expressions merge`で検証する。

| 編集単位 | 通常・折りたたみ・所有する構文へのドリルダウン | 新規作成 | 内容変更 | 構造変更 | 削除 | ソース反映・再表示 |
| --- | --- | --- | --- | --- | --- | --- |
| int, float, string | SVGの値・表記を照合済み | literals sample、通常の入力、バイト値の入力 | 数値・文字列の入力とエスケープ編集 | 式への差し替え、文字列の引用符・raw・行末形式 | 所有する宣言・補間の穴を削除 | 実サーバーで確認済み |
| interp, interp-text, interp-hole | 断片・書式・穴の値と短縮表示を照合済み | 補間テンプレートと＋ | 断片・式・書式・断片のエスケープ編集 | 穴の式の組み立て、断片と穴の追加 | 個別の×、空からの再追加、宣言の削除 | 実サーバーで確認済み |
| name, ident, hat-ident, focus (it^), scope | 名前・スコープ・焦点の距離と値の重複をSVGで照合済み | 名前値・参照・ローカルな焦点 | リネーム・参照追従・参照先と距離の変更 | 名前の追加・解除、スコープ変更、外側の焦点の追加・解除 | 所有する式・宣言を削除 | 実サーバーで確認済み |

残る最終確認は、各行のテストを読み、5種類の操作と3種類の表示状態について何が直接検証され、何が所有する構文を介した検証になるかを記録すること。`visual-editor-unimplemented.md` のチェックは、この照合が終わるまで保留する。
