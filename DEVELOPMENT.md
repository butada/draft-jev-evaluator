# 開発者向けガイド

利用方法と起動設定は [README.md](README.md) にまとめています。このファイルはコード構成と開発方針の案内です。

## 方針と仕様

PoCとして小さく作り、画面を使ってフィードバックを得ながら調整します。変更前に仕様を記録します。自動テストは含めていません。

- [plan.md](plan.md)：企画と要件の更新履歴
- [spec.md](spec.md)：実装前に記録した仕様・変更履歴

これらは経緯を残す文書で、後の節が以前の仕様を更新します。現時点の利用者向け説明はREADMEを参照してください。

## 技術スタックと構成

Python 3.12 / FastAPI / uv / SQLite / JavaScript / Vite / npm / Docker Compose。

| ファイル | 役割 |
|---|---|
| `backend/app.py` | API、OpenRouter接続、生成・評価、並列処理 |
| `backend/store.py` | SQLiteの保存、マイグレーション、マージ、費用台帳 |
| `backend/questions.json` | 初期評価基準。保存された編集内容はSQLite側を使用 |
| `frontend/index.html` | 画面の枠組み |
| `frontend/src.js` | 入力、履歴、比較、Markdown表示 |
| `frontend/style.css` | レイアウトとスタイル |
| `frontend/package-lock.json` | npm依存ロック |
| `pyproject.toml` / `uv.lock` | Python依存定義とロック |
| `Dockerfile` | フロントエンドのビルドとPython実行環境 |
| `compose.yaml` | 起動設定と保存データのマウント |

## ビルドと依存関係

フロントエンドをNode.js 22のコンテナでビルドし、生成した静的ファイルをFastAPIから配信します。Pythonは3.12、uvはDockerfileに記載したバージョンを使用します。

```bash
docker compose build
```

既存処理が完了してから更新版を起動します。再起動時に処理中の候補は中断になります。

```bash
docker compose up -d
```

Python依存を変更した場合は`uv lock`、フロントエンド依存を変更した場合は`npm install --prefix frontend`で対応するロックを更新します。Dockerfileでは`uv sync --frozen --no-dev`と`npm ci`を使います。

## 実装上の留意点

- バックグラウンドジョブとセマフォはプロセス内で管理します。現構成のUvicornは1プロセスです。ワーカーを増やす構成には対応していません。
- 生成10並列、Jev評価3並列。候補は生成終了後に評価へ進みます。
- 実行開始時に元情報・プロンプト・有効状態・評価基準をスナップショット保存します。
- 追加生成はそのスナップショットを使用します。候補ごとに要求モデル・実際のモデル・Effort・生成メタデータも保存します。
- マージは新しい履歴へコピーし、元候補の識別子で重複を防ぎます。評価基準などの照合に失敗した場合はトランザクション内で拒否します。
- 費用はAPI応答の`usage.cost`を台帳へ記録します。候補削除と台帳削除を連動させません。未取得と0 USDを区別します。
- Effort指定時は`reasoning.effort`と`provider.require_parameters=true`を送ります。APIが適用値を返さないときは、要求値から適用実績を推定しません。
- MarkdownはDOMPurifyでサニタイズして表示します。
- 起動時にSQLiteのスキーマ更新を行います。スキーマを変更するときは停止中のDBコピーまたはSQLiteのバックアップ機能で事前にバックアップします。

## 公開ファイル

ソース、設定例、仕様文書、依存ロックファイルを公開対象とします。`.env`、`data/`、DBやバックアップ、依存物、ビルド成果物、個人用設定は`.gitignore`で除外します。Dockerビルドの除外設定は`.dockerignore`です。

`.env.example`にはダミー値だけを置きます。公開用コミットに実際のAPIキーや入力データを含めないでください。

## API参考資料

- [OpenRouter / Jev](https://openrouter.ai/docs/guides/community/jev)
- [Reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
