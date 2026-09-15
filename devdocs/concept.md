# L^ Visual Editor

グラフィカルにL^ スクリプトを編集する専用エディター

オートレイアウトが基本で、自由なレイアウトは不要。なので、L^ソースにレイアウトデータを埋め込むようなことはしなくて良い。

メタデータを持つ予定はあるが、それは多言語化のための情報をソースから分離して持つためのもの。
レイアウトなど作業者ごとに必要なものはさらに別ファイルに格納してgit管理しなくて良い、とする。

| 拡張子 | 用途 | git |
| --- | --- | --- |
| *.lh | スクリプト本体 | ✔ |
| *.lhm | メタデータ（多言語化のための情報などを分離して持ちたい場合。コメントに埋め込むことも可能なので必須ではない） | ✔ |
| *.lhl | ビジュアルエディタのレイアウト情報 | - |

## 大人向けScratch

[Scratch Has a Marketing Problem](https://medium.com/free-code-camp/scratch-has-a-marketing-problem-f84626bd18ef)

↑ここで書かれていることが、まさしく L^ Visual Editor が目指していること。

VisualEditorのUIを使用してプログラミングする分には、SyntaxError等と言われる内容を書きようがない。
L^プログラムソースとして正当な記述しか許されない。初学者に必要なのはこの適切な制限であって「簡単そうな見た目」ではない。

## 文は縦に伸びる

if文 や パターンマッチ文に よる分岐は、分割されて横に並ぶ。

## 式は横に伸びる

if式 や パターンマッチ式に よる分岐は、分割されて縦に並ぶ。

## Visual Editor 用語

最終的に多言語化したいが、取りあえずは日本語と英語を考えていきたい。

### 実行線 （Execute Line?）

文を縦につなぐ白くて太い単方向実線。

### 定義線 （Declation Line?）

let^文の左辺と右辺をつなぐ、青くて細い単方向実線。始点と終点は水平に揃えられる。

### 使用線 （Use Line?）

関数・手続きパラメータへの指定を表す細くてオレンジ色の単方向実曲線。ホバーしたときだけ現れる。

### let^ -> 定数定義 (Let?)

### var^ -> 変数定義 (Var?)

### def^ -> 型定義 (Defination?)

### enum^ -> 列挙体定義 (Enumeration?)

### errordef^ -> エラー定義 (Error Defination?)

### if^文 -> 条件分岐 (Branch?)

### if^式 -> 選択 (Select?)

### for^when^文 -> パターン分岐 (Pattern Matching Branch?)

### for^when^式 -> パターンマッチ (Pattern Match?)

### for^ while^ next^ -> 条件付き繰り返し (Conditional Loop?)

### for^ from^ to^ -> 範囲指定繰り返し (Ranged Loop?)

### repeat^ -> 繰り返し (Repeat)
