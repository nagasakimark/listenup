# 🎧 Listen Up! — 英語ソング・ブランクチャレンジ

生徒が学年（小5〜中3）をえらび、英語の歌を聞きながら「ぬけている単語」を入力するWebアプリです。
GitHub Pages（静的サイト）だけで動きます。教科書は **New Horizon Elementary 5・6（2024）** と **New Horizon 1・2・3（2025）**。

- 生徒がもう習った単語だけがブランクになります（学年ごとに ふえます）。
- 入力は送信ボタンなし。正解した瞬間に つぎへ。まにあわない時だけ曲が自動で止まり、正解でそのまま再開。
- 「えらぶ（4択）」と「タイピング」、「かんたん／ふつう／むずかしい」。ヒント・もう一回・ゆっくり・ずれ調整つき。

## 曲を追加する（先生向け）
1. GitHub で `songs.txt` を開き、YouTube のリンクを1行足して保存（commit）。
   （またはリポジトリの **Actions → 曲を追加・更新 → Run workflow** に URL を貼る）
2. 数分で自動処理され、`songs/` に曲データができてサイトに反映されます。
3. うまくいかなかった曲は Actions のログと `songs/REPORT.txt` に理由が出ます。

処理の中身（`tools/process-songs.mjs`）:
YouTube の動画情報 → 時間つき歌詞（自分で置いた `songs/src/<id>.lrc` → LRCLIB → YouTube字幕の順）→
語彙表で各単語の学年を判定 → `songs/<id>.json` と `songs/index.json` を作成。
歌詞が早い/おそいときは、プレイ画面の ⚙「ずれ」か、`songs.txt` の `offset=1.5` で調整できます。

## 語彙を変える
`tools/source/*.xlsx` を差し替えて `python3 tools/build_vocab.py`（要 openpyxl）→ `tools/vocab.json` が更新されます。
小学校の語彙表は5年/6年に分かれていないため、`tools/elementary_split.json` の「小6で初めて出るジャンル」で分けています。

## ローカルで動かす
`python3 -m http.server` → http://localhost:8000/ （`#demo` を付けると音なしのデモ曲で遊べます）

## 注意
歌詞は著作物です。公開リポジトリに歌詞データを置く点は、学校・自治体の方針に合わせてご判断ください。
