// 【LINE Bot RAG】
// LINEメッセージを受信し、Gemini Embedding + コサイン類似度検索 + Gemini生成で回答する。
// 「質問」で始まるメッセージのみ応答する。

const PROPS              = PropertiesService.getScriptProperties();
const LINE_TOKEN_STUDENT = PROPS.getProperty('LINE_ACCESS_TOKEN_STUDENT');
const LINE_TOKEN_PARENT  = PROPS.getProperty('LINE_ACCESS_TOKEN_PARENT');
const GEMINI_API_KEY     = PROPS.getProperty('GEMINI_API_KEY');
const EMBEDDINGS_FILE_ID = PROPS.getProperty('EMBEDDINGS_FILE_ID');
const PARENT_BOT_USER_ID = PROPS.getProperty('PARENT_BOT_USER_ID');

// ─── LINEユーティリティ ──────────────────────────────────────────────────────

function safeLinePush(to, msg, token) {
  if (!to || String(to).length < 10) return;
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: msg }] }),
    muteHttpExceptions: true,
  });
}

// ─── Webhook エントリポイント ────────────────────────────────────────────────

function doPost(e) {
  var data = JSON.parse(e.postData.contents);
  if (!data.events) return ContentService.createTextOutput('OK');

  var isParent = (data.destination === PARENT_BOT_USER_ID);
  var token    = isParent ? LINE_TOKEN_PARENT : LINE_TOKEN_STUDENT;
  var cache    = CacheService.getScriptCache();

  data.events.forEach(function(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return;
    var userId  = event.source.userId;
    var message = event.message.text || '';
    if (!message.trim().startsWith('質問')) return;

    var evtKey = event.webhookEventId ? 'rag_evt_' + event.webhookEventId : null;
    if (evtKey && cache.get(evtKey)) return;

    var rateKey = 'rag_rate_' + userId;
    var count   = parseInt(cache.get(rateKey) || '0');
    if (count >= 5) return;
    cache.put(rateKey, String(count + 1), 3600);

    var answer = getRagAnswer_(message);
    safeLinePush(userId, answer, token);
    if (evtKey) cache.put(evtKey, '1', 60);
  });

  return ContentService.createTextOutput('OK');
}

// ─── RAG パイプライン ────────────────────────────────────────────────────────

function getRagAnswer_(userMessage) {
  try {
    var queryEmb = embedText_(userMessage);
    if (!queryEmb) return '校舎にお問い合わせください。';

    var chunks = loadEmbeddings_();
    if (!chunks || chunks.length === 0) return '校舎にお問い合わせください。';

    var topChunks = getTopK_(queryEmb, chunks, 5);
    Logger.log('RAG top chunk: ' + topChunks[0].text.substring(0, 80) + ' (sim=' + topChunks[0].sim.toFixed(3) + ')');
    if (topChunks[0].sim < 0.6) return '校舎にお問い合わせください。';

    var context = topChunks.map(function(c) { return c.text; }).join('\n\n---\n\n');
    return askGeminiWithContext_(userMessage, context);
  } catch (e) {
    Logger.log('getRagAnswer_エラー: ' + e);
    return '校舎にお問い合わせください。';
  }
}

// クエリテキストを gemini-embedding-2 でベクトル化する
function embedText_(text) {
  var endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent';
  var options  = {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ content: { parts: [{ text: text }] }, taskType: 'RETRIEVAL_QUERY' }),
    muteHttpExceptions: true,
  };
  try {
    var res    = UrlFetchApp.fetch(endpoint + '?key=' + GEMINI_API_KEY, options);
    var result = JSON.parse(res.getContentText());
    return result.embedding ? result.embedding.values : null;
  } catch (e) {
    Logger.log('embedText_エラー: ' + e);
    return null;
  }
}

// Google Drive から埋め込み済みチャンクJSONを読み込む
function loadEmbeddings_() {
  try {
    var file = DriveApp.getFileById(EMBEDDINGS_FILE_ID);
    var chunks   = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
    var filtered = chunks.filter(function(c) { return c.audience === 'public'; });
    Logger.log('loadEmbeddings_: total=' + chunks.length + ' public=' + filtered.length + ' excluded=' + (chunks.length - filtered.length));
    return filtered;
  } catch (e) {
    Logger.log('loadEmbeddings_エラー: ' + e);
    return null;
  }
}

function dotProduct_(a, b) {
  var sum = 0;
  for (var i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function norm_(v) {
  var sum = 0;
  for (var i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

// コサイン類似度でスコアリングし上位k件を返す
function getTopK_(queryEmb, chunks, k) {
  var qNorm  = norm_(queryEmb);
  var scored = chunks.map(function(c) {
    var sim = dotProduct_(queryEmb, c.emb) / (qNorm * norm_(c.emb));
    return { text: c.text, sim: sim };
  });
  scored.sort(function(a, b) { return b.sim - a.sim; });
  return scored.slice(0, k);
}

// 上位チャンクを文脈として Gemini に渡し回答を生成する
function askGeminiWithContext_(userMessage, context) {
  var endpoint = 'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash-lite:generateContent';
  var prompt =
    'あなたは塾のAIアシスタントです。\n' +
    '以下の参考情報に基づいて質問に回答してください。\n' +
    '参考情報に答えがない場合は「校舎にお問い合わせください」と答えてください。\n' +
    'このボットは生徒・保護者向けのLINEサポートです。\n' +
    '回答は必ず生徒・保護者の視点で書いてください。\n' +
    'スタッフ・校舎向けの内部業務情報は絶対に回答に含めないでください。\n' +
    '回答はMarkdownやHTMLを使わず、プレーンテキストで書いてください。\n' +
    '箇条書きは「・」を使ってください。括弧内の詳細情報も省略せずに記載してください。\n' +
    '各箇条書き項目の後に空行を1行入れてください。\n' +
    'ファイル名・PDF名・URLは回答に含めないでください。\n\n' +
    '=== 参考情報 ===\n' + context + '\n===============\n\n' +
    '質問: ' + userMessage;
  var options = {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    muteHttpExceptions: true,
  };
  try {
    var res    = UrlFetchApp.fetch(endpoint + '?key=' + GEMINI_API_KEY, options);
    var result = JSON.parse(res.getContentText());
    return result.candidates[0].content.parts[0].text;
  } catch (e) {
    Logger.log('askGeminiWithContext_エラー: ' + e);
    return '校舎にお問い合わせください。';
  }
}

// ─── デバッグ用（GASエディタから手動実行） ──────────────────────────────────

function debugRagBot() {
  var question = '質問 入会の流れを教えてください';
  Logger.log('テスト質問: ' + question);

  var queryEmb = embedText_(question);
  if (!queryEmb) { Logger.log('埋め込み失敗'); return; }
  Logger.log('埋め込み成功: ' + queryEmb.length + '次元');

  var chunks = loadEmbeddings_();
  if (!chunks) { Logger.log('チャンク読み込み失敗'); return; }
  Logger.log('チャンク数: ' + chunks.length);

  var top5 = getTopK_(queryEmb, chunks, 5);
  top5.forEach(function(c, i) {
    Logger.log('Top' + (i + 1) + ' (sim=' + c.sim.toFixed(3) + '): ' + c.text.substring(0, 100));
  });

  var start   = new Date().getTime();
  var answer  = getRagAnswer_(question);
  var elapsed = ((new Date().getTime() - start) / 1000).toFixed(1);
  Logger.log('回答 (' + elapsed + '秒): ' + answer);
}
