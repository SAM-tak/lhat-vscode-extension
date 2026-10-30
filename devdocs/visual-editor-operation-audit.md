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
`annotation argument menus`は、空の文書から作ったアノテーションの引数を数値・文字列・名前・真偽値・nilへ変更する。Unicodeと引用名、バイト列のエスケープ表記、通常の引用・raw・行末形式の文字列を作成・再編集し、可変長の引数を追加・削除する。行末形式の後ろへの追加では引数が文字列に吸収されないことも確認する。固定の必須引数には削除候補を出さず、固定個数に達したら追加ボタンを出さない。署名が未解決のアノテーションと、最小個数が0の可変長署名でも、引数0個からの追加と0個までの削除を確認する。
`annotation argument structure edits`は末尾カンマ・隣接するコメント・行コメント・行末文字列の区切りを含めて再解析する。引数の追加・削除後も、所有する宣言と値、残す引数の内容と周囲のコメントを保つ。バイトを含む文字列はエスケープ表記の入力欄と文字列の見た目を使い、無効なエスケープ・不完全な数値・式の入力はソースへ反映しない。
引数の＋は一覧の＋と同じ寸法で、一覧の枠内に収まることをDOMの実寸法で確認する。`LHAT_TEST_ARGUMENT_SCREENSHOT`を指定した同じブラウザーテストの画像でも、引数と追加ボタンが横一列に収まり、付与先の宣言を覆わないことを目視した。

## テーブル・タプルの照合

`mixed tables and tuples`は空の文書から、名前付きの要素・数値キー・タプルの位置要素・入れ子のテーブルと、数値・文字列・テーブルを持つタプルをUIで作る。ASTと字句列を照合し、タプルを2要素から1要素へ減らしたときは括弧付きの単一値として再解析され、同じ入力欄で編集を続けられることを確認する。テーブルの全要素を消した後の再追加と、所有する宣言の削除も確認する。
`computed table keys`はキーを名前・数値・文字列・参照・演算式・呼び出しへ変更し、値を保つこと、キーへの型の追加・解除、要素の削除後も隣のキーと値が残ることを検証する。`trailing tuple arguments`はタプルを引数として作り、展開・解除・内側の値の変更と、所有する引数の削除を確認する。
`table keys and tuple members`は通常表示の宣言名・テーブルの短縮見出し・表示中のタプル要素、展開後の名前キー・文字列キー・数値キーと値、タプルの要素と入れ子の内容をSVGで照合する。数値が重複表示されないことも確認する。折りたたみ後は宣言名・テーブル見出し・タプルの省略表示を確認し、テーブルとタプルのそれぞれへ実際にクリックしてドリルダウンした後、対象のキーと値・位置要素を再照合する。表示操作でソースを変更しない。

## 定義とselfテーブルの照合

`definition and self fields`は空の文書から定義を作り、型付きのインスタンスフィールド、通常のメンバー、コンストラクターと戻すselfテーブル、レシーバーを持つメソッドを追加し、ASTと字句列を照合する。コンストラクター内のselfテーブルを空にしてからフィールドを再追加し、定義の全メンバーを消した後にもselfの節とフィールドを再追加できる。最後に所有する宣言を削除する。
`definition members expose`は抽象・上書き・多重定義の修飾と演算子の変更、`delegated members`は委譲先の追加・変更・削除と再追加、`mutable receivers and fresh promises`はレシーバーの可変性とfreshの約束の変更をUIから確認する。`member-definitions sample`と`inventory definitions`にも、コンストラクター・レシーバー・演算子メンバーを含む空からの再構築と一致検証がある。
`definition and self contents`は通常表示と折りたたみ時の宣言名・定義の見出し、展開時のフィールド名・値・修飾・委譲先・演算子をSVGで照合する。定義へドリルダウンして同じ内容を確認した後、コンストラクターのselfテーブルへさらに入り、他のメンバーを混ぜず、そのフィールドと値を表示することを確認する。値の重複と表示操作によるソース変更も検出する。
`LHAT_TEST_DEFINITION_SVG`を指定した同じテストのSVGを画像化し、インスタンスの雛形と構築する値、通常・抽象・上書き・多重定義・演算子・委譲の行を目視した。演算子名は翻訳した見出しと区切り、`演算子定義 +`の記号が見出しと重ならないようにする。ソースの`op^+`の綴りは変えない。

## 値を包む式の照合

`type queries, boxes and type values`は空の文書からtypeof・box・constboxと型値を作り、内側の値・boxの可変性・型を変更して、包んだ式の解除や別の値への差し替えを確認する。`packed and propagated values`はタプルをpackとtryで包み、内側の数値を編集してASTと字句列を照合し、それぞれの解除と所有する宣言の削除を確認する。`trailing tuple arguments`は最後の引数の展開・解除・値の変更と、所有する引数の削除を確認する。
`wrapper roles and inner values`は通常・折りたたみ時の所有するテーブルの見出しと、展開・ドリルダウン後の各式の見出し・内側の数値・文字列・タプルと展開の記号をSVGで照合する。型値の本文には、値の数値入力とは異なる型の見出しがあることもDOMで確認する。値の重複と表示操作によるソース変更は検出する。

型値の構造編集には、型注釈と同じ綴りでは意味が変わる場合があった。nilへの変更はnilの値、タプルへの変更や交差型からタプルの成分だけを残す変更は型値を並べた値のタプルになり、nullable・交差型への変更は先頭の括弧で式として解釈されていた。型値全体を書き直し、必要な場合に中立な`any^&(...)`を補って型値と型エイリアスの意味を保つ。nullable・交差型・関数型・型記述子の構造テンプレートは全体を括弧で囲み、入れ子の構文でも範囲を保つ。括弧付き関数型の結果をすべて消してから再追加する場合も、関数型の`;`の内側へ結果型を追加する。
`written type values keep descriptor semantics`は基本型、union、タプル、テーブル、関数型と匿名焦点の型値に対し、提示した入力不要の構造変更をすべて実サーバーで再解析する。nil型・タプル型の静的な型、型エイリアスを使った後続の型注釈、コメントの保持、編集を繰り返しても括弧が増えないことも照合する。`nullable and intersection changes`は型注釈の選んだ成分だけに変更が適用され、外側の結合順が変わらないことを確認する。
`written type descriptors keep nil and tuple types`は空の文書からUIで型値を作り、nullable・交差型・タプル型・タプル内の成分・名前入力によるnil型・基本型へ変更し、値への差し替えと宣言の削除まで確認する。初期化中の自分自身と`var`の型値は型候補に出さず、初期化式から見える外側の同名エイリアスは残す。候補の実サーバーでの照合は`type choices exclude mutable descriptors`にある。

## 列挙・エラー定義とエラー値の照合

`error payloads, error kinds and enumeration members`は空の文書から公開のエラー定義と列挙を作り、名前・種別・型付きペイロード・自動採番と明示値・エラー値を編集し、ASTと字句列を照合する。エラー値をtryで包んでから種別を変更し、不要になったペイロードを削除して包みを解除する。ペイロード、エラー種別、列挙メンバーをそれぞれ空にした後にも再追加でき、最後に各宣言を削除する。
`enum sample`には公開・名前変更・自動採番と明示値の往復、文字列・テーブルを値に持つメンバーの作成も含む。`member-definitions sample`と`inventory definitions`には、複数のエラー種別と、型・既定値を持つペイロードのUI作成がある。
`enumerations, error kinds and constructed payloads`は通常・折りたたみ時の定義名と公開の見出し、展開後の列挙の自動採番・数値・文字列、エラー種別と既定値、構築するエラー値の種別とペイロードをSVGで照合する。列挙・エラー定義・エラー値へ個別にドリルダウンした後は、対象の値を重複させず、他の対象の値を混ぜずに表示することを確認する。表示操作でソースを変えない。
`LHAT_TEST_SEMANTIC_ARTIFACTS`にディレクトリを指定すると、これらの展開時のSVGを保存する。`wrapped-values.svg`と`error-enum-values.svg`を画像化し、各式の見出しと内側の値、宣言と構築する値それぞれのペイロード、列挙の自動採番と明示値を目視した。

## 単位宣言・読み込みの照合

`module declarations and both loading forms`は空の文書から単位宣言、文としてのimport・require、テーブルの値としてのimport・requireを作り、ASTと字句列を照合する。日本語の単位名とパス、引用符を含むパスの入力・再表示、値の読み込み形式の切り替え、要素を空にした後の再追加、各文・単位宣言の削除と再追加まで確認する。
`inline module and comment fields`は既存の単位名・読み込み先をインラインで変更して再解析し、`reference-library sample`は単位宣言と公開する値を空から再構築する。`module values import`と`references sample`には、値としてのimportと、requireの結果を束縛して参照する構築がある。
`module names and loading paths`は通常・折りたたみ時の単位宣言と読み込み文の見出し・名前・パス、展開後の値としての読み込みと対応するキー・パスをSVGで照合する。所有するテーブルへドリルダウンした後もそのキー・パスを一度ずつ表示し、外側の単位宣言・読み込み文を混ぜない。表示操作でソースを変更しない。`LHAT_TEST_SEMANTIC_ARTIFACTS`で保存した`module-values.svg`を画像化し、文と値の見出し・パスと、値を束縛するキーへの接続を目視した。

## 演算式・参照先・呼び出しの照合

`operator operands and complex access targets`は空の文書から二項演算と単項演算を作り、被演算子と単項演算子を変えてASTと字句列を照合する。包みを解除してから、値を持つテーブルへの添字参照とメンバー参照、メソッドの呼び出しを構築し、同じ照合を行う。nilチェックの切り替えと、呼び出しを組み立てた後の参照先の添字の変更、値への差し替えと宣言の削除まで確認する。
`unary operator context`は既存の単項演算子の変更、`comparison chains build`は被演算子・比較演算子の変更、比較の追加・削除と二項比較への縮退、`nil-checked member, index and call`は3種類のnilチェックの切り替えとSVGの記号・見出しを検証する。`type tests and casts`は型・値の変更と互換性の判定／型変換の切り替え・差し替え、`computed member receivers`は複雑な参照先に対するメンバー名の変更と呼び出しの構築を検証する。引数の追加と位置・型に関する制約は、`an overloaded call`・`unresolved calls`・`a typed variadic function`・`trailing tuple arguments`にも操作の証拠がある。
`operators and access expressions retain operands`は通常・折りたたみ時の所有するテーブルの見出しと、展開・ドリルダウン後の単項演算・二項演算・比較の連鎖・複雑なメンバー参照・添字参照・呼び出し・型変換のキー、演算子、型の見出し、実際の値をSVGで照合する。各数値が一度ずつ現れることと、表示操作でソースを変更しないことも検証する。保存した`operator-values.svg`を画像化し、複雑な被演算子や参照先を別のボックスとして接続する表示、比較の並びと呼び出しの入力・出力を目視した。

## 関数・引数の照合

`callable parameters retain defaults`は空の文書から数値型・既定値を持つ引数と文字列型の可変長引数、引数を参照する戻り値を作り、ASTと字句列を照合する。引数のリネームで本文の参照が追従し、既定値の解除・再追加・値の変更、全引数の削除と同じシグネチャの再構築、宣言の削除までできる。
この照合で、既定値付き引数の後ろの＋が消える問題を修正した。レイアウト用の行にも末尾の追加ボタンを付けていたが、描画を省く条件がそのボタンを見ていなかった。末尾の追加ボタンを持つ行は残し、既定値付き引数の後ろに可変長引数を追加できるようにする。
可変長引数と名前なしの型引数は、型を上のラベルに一度だけ表示し、可変長の名前には`...`を置く。`callable signatures keep defaults`では、可変長の型が重複して表示されないことも照合する。`variadic annotations omit and restore`は型を省略しても編集用の型ラベルを残し、通常の型・タプル型・省略・再指定をUIで往復して、可変長の値への添字参照と宣言の削除まで確認する。
`unnamed callable type inputs`は、型値の関数シグネチャについても名前なしの入力の型を一度だけ表示すること、可変長だけに`...`を表示すること、折りたたんだ表示でも型の綴りを重複させず、再展開すると各型の編集先を保持することを照合する。`LHAT_TEST_SEMANTIC_ARTIFACTS`で保存した`callable-signatures.svg`・`annotation-types.svg`・`unnamed-parameters.svg`を画像化し、既定値、入出力、修飾、名前なし・可変長の各入力と9種類の型注釈を目視した。
関数型の可変長の型も構造メニューから省略・再指定できる。`variadic element annotations`は本体を持つ関数の型注釈と型値の両方で、隣の引数・結果とコメントを保って往復することを実サーバーで確認する。型候補はLSPの`d26a022`以降で、注釈の有無に関わらず`...`の位置から基本型・スコープ内の型エイリアスを取得する。LSP側の`test_graph_types`でも通常の関数・関数型の両方を検証する。
`function parameter defaults`は文字列の既定値と解除、`a typed variadic function`は可変長の引数・型・値への参照と添字、`callable templates and fresh results`はテンプレート・freshの約束の追加解除と式の差し替え、`mutable receivers and fresh promises`は本体と型注釈それぞれのレシーバー・freshの変更を検証する。複数の入出力の構築は`multiple-returns sample`、引数と結果の型の追加・個別削除は型注釈の操作テストにも証拠がある。
`callable signatures keep defaults`は通常・折りたたみ時にも関数・手続きの見出し、入力・出力、既定値、可変長、テンプレート、fresh、複数の結果型の編集先を保持することをSVGとDOMで照合する。展開・個別の関数へのドリルダウン後は本文も確認し、別の関数の既定値を混ぜない。表示操作でソースを変更しない。

## 型注釈の照合

`all annotation type forms`は名前・関数・コルーチン・型記述子・テーブル・タプル・union・交差型とテーブル内のメンバー宣言を一つの関数の型注釈として再解析する。通常・折りたたみ・所有する関数へのドリルダウンの各表示で、引数名、入力・出力、複数の結果型の編集先、短縮した型名と完全な型情報のツールチップを照合する。テーブルの名前付きメンバー・位置要素の個数・索引型・self節内の型、コルーチンの種類・入出力と終了しない指定、タプルの各要素、unionと交差型の成分がツールチップから失われないことを検証する。各引数の型から構造編集メニューを実際に開き、テーブル型のメンバー名・位置の個数をメニューでも照合する。表示とメニューの開閉ではソースを変更しない。
空からの作成と構造変更は`type labels construct`・`nested tuple, applied and coroutine types`・`table member names and function type arities`で、型の名前・成分の変更、リストの追加・個別削除、型の形式の切り替えと再表示まで検証する。`typed instance positions and indexers`・`positional counts, type indexers`はself節・位置要素の個数／単一／無制限・索引型の作成変更削除、`coroutine kind, omitted slots`は関数／手続き／両方・型／省略／任意・終了しない結果の切り替え、`quoted type member names`は引用名・修飾型名とメンバーの編集を検証する。`return type delete buttons`は複数の結果型を個別に消し、最後の削除で推論に戻す。型名の候補・型値の意味・成分の結合順の検証は「値を包む式の照合」に記録する。

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
| annotation | 名前・引数・一覧の折りたたみと所有する関数へのドリルダウンをSVGで照合済み | 一時ボックスと登録名の選択 | 名前の選択、引数の入力・表記変更 | 引数の種類変更、可変長引数の追加・削除 | 各行の×、引数の削除、最後の一覧の消滅 | 実サーバーで確認済み |
| table, tuple, table-entry | キー・値・位置要素と短縮表示をSVGで照合済み | 空の文書から混在・入れ子の内容を作成 | キーのリネーム・式の変更、値の入力 | キーの種類・型・式、タプルの展開・解除、要素の追加 | 要素・引数・宣言の削除、単一値への縮退、空からの再追加 | 実サーバーで確認済み |
| def, self-table | 定義・selfの見出し、メンバー・値・修飾をSVGで照合済み | フィールド・コンストラクター・メソッドを空から作成 | 名前・値・型・本体の式、委譲先の変更 | 修飾・演算子・レシーバー・freshの変更、メンバーの追加 | フィールド・メンバー・宣言の削除、空からの再追加 | 実サーバーで確認済み |
| typeof, type, spread, pack, box | 所有するテーブル経由で各見出し・型値・内側の値・展開を照合済み | 型の取得・型値・box・pack・引数の展開 | 内側の値・型の変更 | box/constbox、包みと展開の追加・解除 | 包みの解除、式の差し替え、引数・宣言の削除 | 実サーバーで確認済み |
| error-new, try | 種別・ペイロード・伝播と対象ごとの内容をSVGで照合済み | 空からエラー値・型付きペイロード・伝播を作成 | 種別・ペイロードの名前と値の変更 | 伝播の追加・解除、ペイロードの追加 | ペイロード・伝播・宣言の削除、空からの再追加 | 実サーバーで確認済み |
| errordef, error-kind, enumdef, enum-member | 名前・種別・値・公開と短縮表示をSVGで照合済み | 空から定義・種別・メンバーを作成 | 名前・型・既定値・明示値の変更 | 公開、自動採番/明示値、メンバーの追加 | ペイロード・種別・メンバー・宣言の削除、空からの再追加 | 実サーバーで確認済み |
| module, require, require-stmt, import, import-stmt | 文と値の見出し・名前・パスと対象の内容をSVGで照合済み | 空から単位宣言、読み込み文と値を作成 | 単位名・読み込み先、日本語・引用符を含むパス | 値の読み込み形式の切り替え、要素の追加 | 文・宣言・要素の削除、空からの再追加 | 実サーバーで確認済み |
| unary, binary, compare-chain, member, index, call, as | 所有するテーブル経由で各演算子・値・参照先・見出しをSVGで照合済み | 空から演算・比較・参照・呼び出し・型変換を作成 | 演算子・被演算子・参照先・添字・引数・型の変更 | 単項演算の包み、比較の追加・縮退、nilチェック、判定/変換、引数の追加 | 包みの解除、値への差し替え、引数・宣言の削除 | 実サーバーで確認済み |
| func, param | 通常・折りたたみ時のシグネチャと、関数ごとの本文・既定値・修飾を照合済み | 空から引数・型・既定値・可変長・本文を作成 | 引数名・参照追従・既定値・入出力の型と値 | テンプレート・fresh・レシーバー・引数と結果の追加、可変長の型の省略と再指定 | 引数・既定値・結果の型・宣言の削除、空からの再構築 | 実サーバーで確認済み |
| type-name, type-func, type-coro, type-apply, type-table, type-tuple, type-union, type-intersect, member-decl | 所有する関数経由で短縮型・完全なツールチップ・結果型の編集先を照合済み | 型の構造メニューから各形式・メンバー・入出力を作成 | 型名・メンバー名・各成分・位置の個数の変更 | 型の形式・成分・リスト・コルーチンの種類と各スロット・レシーバー・freshの変更 | 成分・メンバー・引数・結果の型の削除、最後の結果を推論へ戻す | 実サーバーで確認済み |

未照合の編集単位は、宣言・再代入、単独の呼び出し文、ブロック、条件・パターン分岐、戻り・離脱・panic、中断する式、with、ループ、不正な入力からの回復。各行のテストを読み、5種類の操作と3種類の表示状態について何が直接検証され、何が所有する構文を介した検証になるかを記録する。`visual-editor-unimplemented.md` のチェックは、この照合が終わるまで保留する。
