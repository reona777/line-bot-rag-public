# LINE Bot × RAG（Gemini + Google Apps Script）

LINEメッセージ「質問 ○○」に対し、独自の知識ベースを参照して自動回答するRAGボット。  
Google Apps Script上で完結するため、サーバーレスでゼロインフラ運用が可能。

---

## 解決する課題

塾や学校などの現場では、生徒・保護者から同じ質問が繰り返し寄せられる。  
スタッフの対応工数を削減しつつ、24時間即時回答を実現するために本ボットを構築した。

---

## アーキテクチャ

```
生徒・保護者（LINE）
       │
       │ 「質問 入会金はいくらですか？」
       ▼
LINE Messaging API
       │  Webhook POST
       ▼
Google Apps Script（doPost）
       │
       ├─① embedText_()
       │      Gemini Embedding API でクエリをベクトル化
       │      モデル: gemini-embedding-2（3072次元）
       │
       ├─② loadEmbeddings_()
       │      Google Drive から埋め込み済みチャンクを読み込み
       │      （約950チャンク・25MB の JSON）
       │
       ├─③ getTopK_()
       │      コサイン類似度を全チャンクと計算し上位5件を取得
       │
       └─④ askGeminiWithContext_()
              参考情報としてチャンクを与え Gemini に回答生成を依頼
              モデル: gemini-2.0-flash-lite
                     │
                     ▼
            生徒・保護者（LINE）へ返信
```

---

## RAGパイプライン

### 知識ベースの構築（オフライン）

```
社内ナレッジベース
    │ スクレイピング
    ▼
テキストチャンク分割
（1チャンク = 1トピック、キーワードを見出しに含める）
    │
    ▼
Gemini Embedding API でベクトル化
    │
    ▼
embeddings.json として Google Drive に保存
```

### チャンク設計のポイント

- **1チャンク = 1質問に対応する粒度** に設計  
  大きすぎるチャンクは類似度を下げるため、FAQ1件ごとにチャンクを分割
- **ヘッダーに複数キーワードを含める**  
  例：`【料金:入会金・初期費用・再入会】` のように検索クエリのゆれに対応
- **重要な数値・事実をチャンク冒頭に配置**  
  Gemini が文脈を正確に拾いやすくする

### プロンプト設計のポイント

- 内部業務情報（スタッフ向け手順・社内申請フロー）を回答に含めないよう明示
- 回答フォーマットを統一（Markdown禁止・「・」箇条書き・省略禁止）
- 参考情報にない内容は「校舎にお問い合わせください」と回答するよう指示

---

## 技術スタック

| 技術 | 用途 |
|------|------|
| Google Apps Script | Webhookサーバー・RAGロジック全体 |
| LINE Messaging API | メッセージ受信・返信 |
| Gemini Embedding API（gemini-embedding-2） | クエリ・チャンクのベクトル化（3072次元） |
| Gemini API（gemini-2.0-flash-lite） | 回答生成 |
| Google Drive | 埋め込みJSONの保管・読み込み |

### GASを採用した理由

- サーバー・コンテナ管理が不要でインフラコストがゼロ
- Google Drive・Sheets・DocsとのAPI連携がネイティブで容易
- LINEのWebhook受信に必要な `doPost` エンドポイントをそのまま公開できる

---

## ファイル構成

```
コード.js          # GAS本体（Webhookエントリ + RAGパイプライン）
appsscript.json   # GASプロジェクト設定
```

### コード構成（コード.js）

| 関数 | 役割 |
|------|------|
| `doPost(e)` | LINEからのWebhookを受信し「質問」メッセージのみRAGへルーティング |
| `safeLinePush()` | LINE Push Messageを送信 |
| `getRagAnswer_()` | RAGパイプラインのメイン関数 |
| `embedText_()` | Gemini Embedding APIでテキストをベクトル化 |
| `loadEmbeddings_()` | Google DriveからJSON形式の知識ベースを読み込み |
| `getTopK_()` | コサイン類似度でスコアリングし上位k件を返す |
| `askGeminiWithContext_()` | 上位チャンクを文脈としてGeminiに回答生成を依頼 |
| `debugRagBot()` | GASエディタから手動実行できる動作確認用関数 |

---

## セットアップ

### 1. スクリプトプロパティの設定

GASエディタ → プロジェクトの設定 → スクリプトプロパティ に以下を追加。

| キー | 説明 |
|------|------|
| `GEMINI_API_KEY` | Google AI Studio で取得 |
| `EMBEDDINGS_FILE_ID` | 知識ベースJSONを保存したGoogle DriveファイルID |
| `LINE_ACCESS_TOKEN_STUDENT` | 生徒用チャンネルのChannel Access Token |
| `LINE_ACCESS_TOKEN_PARENT` | 保護者用チャンネルのChannel Access Token |
| `PARENT_BOT_USER_ID` | 保護者用チャンネルのBot User ID（生徒/保護者の振り分けに使用） |

### 2. 知識ベースの準備

埋め込み済みチャンクJSONを以下の形式で用意し、Google Driveにアップロードする。

```json
[
  { "text": "【カテゴリ:トピック】\n質問内容と回答...", "emb": [0.123, -0.456, ...] },
  ...
]
```

埋め込み生成には `gemini-embedding-2`（3072次元）を使用。

### 3. デプロイ

GASエディタ → デプロイ → 新しいデプロイ → ウェブアプリとして公開。  
発行されたURLをLINE DevelopersコンソールのWebhook URLに設定する。

---

## 動作確認

GASエディタで `debugRagBot()` を手動実行すると、埋め込み生成・類似度検索・回答生成の各ステップをログで確認できる。

```
テスト質問: 質問 入会の流れを教えてください
埋め込み成功: 3072次元
チャンク数: 954
Top1 (sim=0.812): 【入会:入会手続き・流れ・申し込み方法】...
Top2 (sim=0.798): ...
回答 (1.4秒): ご入会の流れをご案内します。...
```

---

## ライセンス

MIT
