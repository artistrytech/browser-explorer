# Explorer Browser

Explorer(ファイル管理)を主画面に、テキスト編集(Monaco)と Git 管理を統合した
ローカル Web アプリ。

## 設定

初回セットアップ時は `config.jsonc.sample` を `config.jsonc` にコピーして作成し、
必要に応じてポートやトークンを調整する。JSONC 形式なので `//` コメントを書ける
(コンテキストメニューの表示設定 `contextMenu` など、各項目の説明はサンプル内のコメント参照)。

## 起動

```bash
npm install
npm run dev     # server (127.0.0.1:5175) + client (127.0.0.1:5173) を並列起動
```

ブラウザで <http://127.0.0.1:5173/> を開く。カレントパスは URL の `?path=` に反映される。

## 構成

```
config.jsonc     # ポート・API トークン・メニュー表示設定 (コメント可)
data/app.db      # SQLite (設定・ブックマーク等の永続化)
server/          # Express + simple-git + chokidar + better-sqlite3
client/          # React + Vite + Zustand + Monaco Editor
```

## 主な操作 (Windows 流キーバインド)

| キー | 動作 |
| --- | --- |
| Return / ダブルクリック | 開く |
| F2 | リネーム |
| Alt+↑ / Alt+← / Alt+→ | 上の階層 / 戻る / 進む (ブラウザ履歴連動) |
| Ctrl+C / Ctrl+X / Ctrl+V | コピー / 切り取り / 貼り付け (切り取り→貼付で移動) |
| Delete / Shift+Delete | ゴミ箱へ / 完全削除 |
| Ctrl+S / Ctrl+Shift+S | 保存 / すべて保存 (エディタ) |

- エンコーディング (UTF-8 / Shift_JIS / EUC-JP / UTF-16)・改行 (CRLF/LF/CR)・BOM は
  ステータスバーから切替。「再読込」で開き直し、Ctrl+S で変換保存。
- Git はシステムの git を使用。push/pull の認証は git 側 (credential helper / SSH agent) に委譲。
- 設定・ブックマーク・リポジトリ一覧は SQLite に永続化。設定画面からエクスポート / インポート可。

## 追加機能 (.docs/002.md)

- **ログを表示**: Git 管理下のファイル/フォルダを右クリック → 対象パスで絞り込んだ履歴
  (ファイルはリネーム追跡 `--follow`)。「絞り込み解除」で全体表示へ。
- **Git グラフ**: Git パネルの「ログ」タブ (絞り込みなし時) はコミット DAG をレーン描画。
  ref チップ表示、右クリックで checkout / reset / cherry-pick / タグ付け。
- **競合を解消**: マージ/リベース/cherry-pick 進行中は Git パネルにバナー表示、
  フォルダ右クリックに「競合を解消…」。競合一覧 → 3-way 解消ツール
  (自分/相手の対比 + Monaco の編集可能な統合結果ペイン)。バイナリ・片側削除は片側採用のみ。
- **Git Clone…**: Git 管理外のフォルダ/空白の右クリックから。ブランチ指定 / shallow /
  サブモジュール対応、進捗を WebSocket でストリーム表示。
- **OS 連携**: フォルダ/空白の右クリックに「Explorer(Finder)で開く」
  「コマンドプロンプト(ターミナル)で開く」(ホスト OS に応じて自動切替)。
- **フォーカス復元**: 選択/スクロール位置を sessionStorage に保持し、
  ブラウザバック/リロードで同じフォルダに戻った際に復元 (タブを閉じると破棄)。
- **ピン止め**: フォルダをクイックアクセスへピン止め/解除 (解除は確認ダイアログ付き。
  ブックマークを外すだけでフォルダ本体には影響しない)。

## セキュリティ (plan §2.2)

- 127.0.0.1 のみで待受、Host/Origin 検証、`x-app-token` によるトークン必須。
- 削除は既定でゴミ箱送り (完全削除は確認付きの明示操作のみ)。

## メモ

- 設計書は macOS 前提だが、実装はクロスプラットフォーム (Windows ではドライブレターを
  ボリュームとして列挙、ゴミ箱はごみ箱に対応)。
- この環境では `tsx watch` が動作しないため、server の dev スクリプトは
  `node --watch --import tsx` を使用している。
