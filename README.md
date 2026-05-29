# 在庫検品アプリ — フロントエンド（GitHub Pages 用）

スマホ Safari/Chrome で動作する SPA。GAS WebApp の JSON API を fetch で呼び出します。

## 構成

```
web/
├── index.html                  # 4 ビュー統合（初回設定 / セッション開始 / 検品中 / 集計）
├── css/style.css               # スタイル（earthy 系カラー、Yu Gothic）
└── js/
    ├── app.js                  # SPA ロジック・localStorage・カメラ・送信キュー
    └── vendor/
        └── html5-qrcode.min.js # v2.3.8 (Apache 2.0)
```

## デプロイ手順（GitHub Pages）

### 1. GitHub に新規 Public リポジトリを作成

リポジトリ名の例: `flag-inventory-scan`

### 2. ローカル初期化 → push

`web/` ディレクトリ単体で git 化:

```bash
cd "/Users/shoti/Documents/claudecode/Flag/03_system/業務システム_Tom/在庫検品アプリGAS/web"
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:<github-user>/flag-inventory-scan.git
git push -u origin main
```

> `web/` の親ディレクトリには `.gs` や Walter 監査前の旧 HTML が残っているため、必ず `web/` 単体で git init すること（親で init すると秘匿物が混入する）。

### 3. GitHub Pages を有効化

リポジトリ Settings → Pages → Source: `Deploy from a branch` → Branch: `main` / `/ (root)` → Save

数十秒で `https://<github-user>.github.io/flag-inventory-scan/` で公開される。

### 4. スマホで開く

URL を控えて店舗スタッフに共有（Slack public channel ではなく LINE 公式や限定チャネル経由を推奨）。

## 運用フロー（初回利用）

1. スマホでデプロイ URL を開く
2. 「GAS API URL」欄に GAS WebApp の `/exec` URL を入力（管理者から共有）
3. 「スプレッドシート URL」欄に蓄積先スプシ URL を入力
4. 「接続テスト」→ 「✓ シート○○に接続できました」が表示されたら「このURLを保存して進む」
5. セッション開始 → 検品

以降は localStorage に記憶されるので入力不要。

## トラブルシュート

| 症状 | 対処 |
|---|---|
| 「API URL 未設定」 | View A で GAS API URL を入力 |
| 「書込許可リストに登録されていません」 | GAS の Script Properties `ALLOWED_SS_IDS` に対象 ssId を追加 |
| CORS エラー（DevTools に出る） | GAS WebApp が `/exec` で公開済か確認、`Content-Type: text/plain` が `app.js` で維持されているか確認 |
| 「シートを開けません」 | GAS オーナーアカウントに対象スプシを編集者で共有 |
| カメラが起動しない | スマホ設定でカメラ権限許可 / 📸撮影ボタン（フォールバック）を使う |
| 「不正な文字を含むバーコード」 | JAN は数字/英字/`-` のみ許容。手動入力で修正 |
| 「1回の送信は500件まで」 | バッチを分割 |

## セキュリティメモ

- API URL は localStorage 保存のみ。リポジトリ内にハードコードしない（公開リポでも漏洩リスクゼロ）
- 外部 CDN 参照ゼロ（html5-qrcode は vendor 配下ローカル配信）
- フォントはシステムフォント（Yu Gothic 系）のみ
- スプシ書込時の数式インジェクション対策・件数上限・JAN 文字制限は GAS バックエンド側で実施

## ファイル更新フロー

フロント変更 → `git commit && git push` のみ。GitHub Pages が自動再ビルド（数秒～1分）。
バックエンド（GAS）変更 → 別管理（在庫検品アプリGAS ディレクトリで `clasp push --force`）。

## ライセンス・参照

- `js/vendor/html5-qrcode.min.js`: html5-qrcode v2.3.8 / Apache License 2.0 / https://github.com/mebjas/html5-qrcode
- アプリ本体は社内利用専用
