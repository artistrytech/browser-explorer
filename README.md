# Explorer Browser

Explorer(ファイル管理)を主画面に、テキスト編集(Monaco)と Git 管理を統合した
ローカル Web アプリ。設計は [_docs/plan.md](_docs/plan.md) を参照。

## 起動

```bash
npm install
npm run dev     # server (127.0.0.1:5175) + client (127.0.0.1:5173) を並列起動
```

ブラウザで <http://127.0.0.1:5173/> を開く。カレントパスは URL の `?path=` に反映される。

## 構成

```
config.json      # ポート・API トークン
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

## セキュリティ (plan §2.2)

- 127.0.0.1 のみで待受、Host/Origin 検証、`x-app-token` によるトークン必須。
- 削除は既定でゴミ箱送り (完全削除は確認付きの明示操作のみ)。

## メモ

- 設計書は macOS 前提だが、実装はクロスプラットフォーム (Windows ではドライブレターを
  ボリュームとして列挙、ゴミ箱はごみ箱に対応)。
- この環境では `tsx watch` が動作しないため、server の dev スクリプトは
  `node --watch --import tsx` を使用している。
