// 【LINE Bot RAG 統合スクリプト】

const PROPS                      = PropertiesService.getScriptProperties();
const LINE_ACCESS_TOKEN_STUDENT  = PROPS.getProperty('LINE_ACCESS_TOKEN_STUDENT');
const LINE_ACCESS_TOKEN_PARENT   = PROPS.getProperty('LINE_ACCESS_TOKEN_PARENT');
const LINE_ACCESS_TOKEN_OFFICIAL = PROPS.getProperty('LINE_ACCESS_TOKEN_OFFICIAL');
const SLACK_BOT_TOKEN            = PROPS.getProperty('SLACK_BOT_TOKEN');
const SPREADSHEET_ID             = PROPS.getProperty('SPREADSHEET_ID');
const PARENT_CHANNEL_ID          = PROPS.getProperty('PARENT_CHANNEL_ID');
const BOT_USER_ID                = PROPS.getProperty('BOT_USER_ID');
const PARENT_BOT_USER_ID         = PROPS.getProperty('PARENT_BOT_USER_ID');
const OFFICIAL_BOT_USER_ID       = PROPS.getProperty('OFFICIAL_BOT_USER_ID');
const DRIVE_FOLDER_ID            = PROPS.getProperty('DRIVE_FOLDER_ID');
const GEMINI_API_KEY             = PROPS.getProperty('GEMINI_API_KEY');
const KNOWLEDGE_DOC_ID           = PROPS.getProperty('KNOWLEDGE_DOC_ID');
const EMBEDDINGS_FILE_ID = PROPS.getProperty('EMBEDDINGS_FILE_ID');
const SHEET_NAME                 = PROPS.getProperty('SHEET_NAME');
const LINE_SHEET_NAME            = PROPS.getProperty('LINE_SHEET_NAME');
const DEFAULT_CHANNEL            = PROPS.getProperty('DEFAULT_CHANNEL');
const ERROR_NOTIFY_CHANNEL_ID    = PROPS.getProperty('ERROR_NOTIFY_CHANNEL_ID');
const SCHOOL_NAME                = PROPS.getProperty('SCHOOL_NAME');

const COL = {
  DAY_OF_WEEK          : 0,
  NAME                 : 1,
  PROMISE_IN           : 2,
  CHECKIN              : 3,
  PROMISE_OUT          : 4,
  CHECKOUT             : 5,
  ABSENT               : 6,
  PARENT_CHECKIN_NOTIF : 7,
  STUDENT_LATE_NOTIF   : 8,
  STUDENT_OUT_NOTIF    : 9,
  PARENT_LATE_NOTIF    : 10,
  PARENT_OUT_NOTIF     : 11,
  STUDENT_LINE_ID      : 12,
  PARENT_LINE_ID       : 13,
};

// ─── エラーユーティリティ ───────────────────────────────────────────────────

function makeErrorResponse(errorMessage) {
  return {
    getResponseCode: function() { return 0; },
    getContentText: function() { return JSON.stringify({ ok: false, error: errorMessage || 'exception' }); }
  };
}

function notifyApiError(service, action, target, response, extra) {
  try {
    let code = '';
    let body = '';
    if (response) {
      code = response.getResponseCode ? response.getResponseCode() : '';
      body = response.getContentText ? response.getContentText() : '';
    }
    const text =
      `⚠️ API送信失敗\n` +
      `サービス：${service}\n` +
      `処理：${action}\n` +
      `対象：${target || '不明'}\n` +
      `HTTP：${code || '不明'}\n` +
      `詳細：${body || extra || 'なし'}`;
    Logger.log(text);
    UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: { 'Authorization': 'Bearer ' + SLACK_BOT_TOKEN },
      payload: JSON.stringify({ channel: ERROR_NOTIFY_CHANNEL_ID, text: text }),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('notifyApiError自体が失敗: ' + err);
  }
}

// ─── Slack / LINE 送信ラッパー ───────────────────────────────────────────────

function safeSlackPost(channel, text, action) {
  try {
    const res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: { 'Authorization': 'Bearer ' + SLACK_BOT_TOKEN },
      payload: JSON.stringify({ channel: channel, text: text }),
      muteHttpExceptions: true
    });
    let body = {};
    try { body = JSON.parse(res.getContentText() || '{}'); }
    catch (parseErr) { body = { ok: false, error: 'json_parse_error: ' + parseErr }; }
    if (res.getResponseCode() !== 200 || !body.ok) {
      notifyApiError('Slack', action || 'chat.postMessage', channel, res);
    }
    return res;
  } catch (err) {
    notifyApiError('Slack', action || 'chat.postMessage', channel, null, String(err));
    return makeErrorResponse(String(err));
  }
}

function safeLinePush(to, msg, token, action, silent = false) {
  try {
    if (!to || String(to).length < 10) {
      if (!silent) notifyApiError('LINE', action || 'push message', to, null, 'LINE IDが空または不正です');
      return makeErrorResponse('invalid_line_user_id');
    }
    const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: msg }] }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      if (!silent) notifyApiError('LINE', action || 'push message', to, res);
    }
    return res;
  } catch (err) {
    if (!silent) notifyApiError('LINE', action || 'push message', to, null, String(err));
    return makeErrorResponse(String(err));
  }
}

/**
 * LINE送信して成功時のみ true を返す。
 * 失敗時は通知済フラグをセットしないよう呼び出し元で制御できる。
 * safeLinePush がすでにnotifyApiErrorを呼ぶが、
 * 「通知済セットを抑止した」ことを追加でエラー通知チャンネルに知らせる。
 */
function sendLineChecked(to, msg, token, name, action) {
  const res = safeLinePush(to, msg, token, action, true);
  try {
    const code = res.getResponseCode();
    const body = JSON.parse(res.getContentText() || '{}');
    if (code === 200 && body.ok !== false) return true;

    // クールダウンチェック
    const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    const propKey = `fail_notif_${name}_${action}_${today}`;
    const props = PropertiesService.getScriptProperties();
    if (!props.getProperty(propKey)) {
      safeSlackPost(
        ERROR_NOTIFY_CHANNEL_ID,
        `📵 LINE送信失敗のため「通知済」をセットしませんでした（次回トリガーで再送します）\n` +
        `対象：${name}（${action}）\nHTTP：${code}\n詳細：${res.getContentText()}`,
        'LINE送信失敗→通知済セット抑止'
      );
      props.setProperty(propKey, '1');
    }
    return false;
  } catch (e) {
    return false;
  }
}

// ─── LINEシートユーティリティ ────────────────────────────────────────────────

function normalizeLineName_(value) {
  return String(value || "").normalize("NFKC").replace(/[ 　]/g, "").trim();
}

function buildParentLineMap_(lineValues) {
  const parentMap = {};
  for (let i = 1; i < lineValues.length; i++) {
    const parentUid         = String(lineValues[i][4] || "").trim();
    const parentStudentName = String(lineValues[i][6] || "").trim();
    if (!parentUid || !parentStudentName) continue;
    parentMap[normalizeLineName_(parentStudentName)] = parentUid;
  }
  return parentMap;
}

function isParentLineUserId_(lineUserId) {
  const ss         = SpreadsheetApp.openById(SPREADSHEET_ID);
  const lineSheet  = ss.getSheetByName(LINE_SHEET_NAME);
  const lineValues = lineSheet.getDataRange().getValues();
  const target     = String(lineUserId || "").trim();
  if (!target) return false;
  for (let i = 1; i < lineValues.length; i++) {
    const parentUid = String(lineValues[i][4] || "").trim();
    if (parentUid && parentUid === target) return true;
  }
  return false;
}

// ─── doGet / doPost ──────────────────────────────────────────────────────────

function doGet(e) {
  const callback   = e && e.parameter ? e.parameter.callback : "";
  const ss         = SpreadsheetApp.openById(SPREADSHEET_ID);
  const lineSheet  = ss.getSheetByName(LINE_SHEET_NAME);
  const lineValues = lineSheet.getDataRange().getValues();
  const parentMap  = buildParentLineMap_(lineValues);

  const students = [];
  for (let i = 1; i < lineValues.length; i++) {
    const studentUid  = String(lineValues[i][0] || "").trim();
    const studentName = String(lineValues[i][2] || "").trim();
    if (studentUid && studentName) {
      const key = normalizeLineName_(studentName);
      students.push({ id: studentUid, name: studentName, parentId: parentMap[key] || "" });
    }
  }

  const parents = [];
  for (let i = 1; i < lineValues.length; i++) {
    const parentUid         = String(lineValues[i][4] || "").trim();
    const parentStudentName = String(lineValues[i][6] || "").trim();
    if (parentUid && parentStudentName) {
      parents.push({ id: parentUid, name: parentStudentName });
    }
  }

  const slackSheet = ss.getSheetByName("slack ID");
  const slackMap   = {};
  if (slackSheet) {
    const slackValues = slackSheet.getDataRange().getValues();
    for (let i = 0; i < slackValues.length; i++) {
      if (slackValues[i][0] && slackValues[i][1]) {
        slackMap[slackValues[i][0].toString().trim()] = slackValues[i][1].toString().trim();
      }
    }
  }

  const json   = JSON.stringify({ students, parents, slackIds: slackMap });
  const output = callback ? callback + '(' + json + ')' : json;
  return ContentService.createTextOutput(output).setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function doPost(e) {
  const data = JSON.parse(e.postData.contents);

  if (data.students) {
    const results = data.students.map(s => {
      try {
        const lineUserId = String(s.lineUserId || "").trim();
        const isParent   = isParentLineUserId_(lineUserId);
        const token      = isParent ? LINE_ACCESS_TOKEN_PARENT  : LINE_ACCESS_TOKEN_STUDENT;
        const action     = isParent ? `一括保護者LINE送信: ${s.name}` : `一括生徒LINE送信: ${s.name}`;
        const res        = safeLinePush(lineUserId, s.message, token, action);
        const code       = res.getResponseCode();
        if (code === 200) {
          return { name: s.name, status: 'sent', recipient: isParent ? 'parent' : 'student' };
        }
        const body       = JSON.parse(res.getContentText());
        const rawMsg     = body.message || body.error || '不明なエラー';
        const detail     = body.details?.[0]?.message || '';
        const statusMap  = {
          400: 'リクエスト不正（UID無効・トークン期限切れ等）',
          401: '認証失敗（Channel Access Tokenを確認）',
          403: 'ブロックまたは権限なし',
          429: 'レート制限超過（送信過多）',
          500: 'LINE APIサーバーエラー',
        };
        const msgPatterns = [
          { pattern: /not agreed/i,       label: 'LINE連携未同意' },
          { pattern: /reply token/i,      label: 'リプライトークンが無効' },
          { pattern: /user.*not.*valid/i, label: 'UID形式が不正' },
          { pattern: /blocked/i,          label: 'ユーザーにブロックされています' },
          { pattern: /not found/i,        label: 'ユーザーが見つかりません' },
        ];
        const matched     = msgPatterns.find(({ pattern }) => pattern.test(rawMsg) || pattern.test(detail));
        const friendlyMsg = matched?.label || statusMap[code] || `エラー(${code}): ${rawMsg}`;
        Logger.log(`LINE送信失敗 [${s.name} / ${isParent ? '保護者' : '生徒'}]: ${code} / ${rawMsg}${detail ? ' / ' + detail : ''}`);
        return { name: s.name, status: 'failed', recipient: isParent ? 'parent' : 'student', error: friendlyMsg, code: code };
      } catch(err) {
        notifyApiError('LINE', `一括LINE送信: ${s.name}`, s.lineUserId, null, String(err));
        return { name: s.name, status: 'failed', error: String(err) };
      }
    });
    return ContentService.createTextOutput(JSON.stringify({ results })).setMimeType(ContentService.MimeType.JSON);
  }

  if (data.type === "url_verification") {
    return ContentService.createTextOutput(JSON.stringify({ challenge: data.challenge }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (data.event && data.event.type === "message" && !data.event.bot_id) {
    const subtype = data.event.subtype || "";
    if (subtype !== "" && subtype !== "file_share") return ContentService.createTextOutput("OK");
    const eventId = data.event_id || data.event.ts;
    if (isDuplicate(SPREADSHEET_ID, eventId)) return ContentService.createTextOutput("OK");
    saveEventId(SPREADSHEET_ID, eventId);
    const text         = data.event.text || "";
    const isSlackToLine = text.includes("<@" + BOT_USER_ID + ">") &&
      (text.includes("転送") || text.includes("保護者") || text.includes("全員"));
    if (isSlackToLine) handleSlackToLine(data.event);
    return ContentService.createTextOutput("OK");
  }

  if (data.events) {
    const sheet             = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(LINE_SHEET_NAME);
    const values            = sheet.getDataRange().getValues();
    const isParentWebhook   = (data.destination === PARENT_BOT_USER_ID);
    const isOfficialWebhook = (data.destination === OFFICIAL_BOT_USER_ID);

    data.events.forEach(event => {
      if (event.type === "message" && (
        event.message.type === "text"    ||
        event.message.type === "image"   ||
        event.message.type === "file"    ||
        event.message.type === "sticker"
      )) {
        const userId  = event.source.userId;
        const message = event.message.text || "";
        if (isOfficialWebhook)     handleOfficialLine(userId, message, event);
        else if (isParentWebhook)  handleParentLine(userId, message, sheet, values, event);
        else                       handleStudentLine(userId, message, sheet, values, event);
      }
    });
  }

  return ContentService.createTextOutput("OK");
}

// ─── LINEハンドラー ──────────────────────────────────────────────────────────

function handleOfficialLine(userId, message, event) {
  const profile = UrlFetchApp.fetch(
    "https://api.line.me/v2/bot/profile/" + userId,
    { headers: { "Authorization": "Bearer " + LINE_ACCESS_TOKEN_OFFICIAL }, muteHttpExceptions: true }
  );
  if (profile.getResponseCode() !== 200) {
    notifyApiError('LINE', '公式LINEプロフィール取得', userId, profile);
    return;
  }
  const lineName = JSON.parse(profile.getContentText()).displayName;
  upsertOfficialLineUser_(userId, lineName);

  if (event.message.type === 'text') {
    safeSlackPost("C0AUT94D3NK", `<!channel>\n名前：${lineName}\n内容：${message}`, "公式LINEからSlack転送");
  }
  if (event.message.type === 'image') {
    transferLineImageToSlack(event.message.id, "C0AUT94D3NK", lineName, LINE_ACCESS_TOKEN_OFFICIAL);
  }
  if (event.message.type === 'file') {
    transferLineFileToSlack(event.message.id, event.message.fileName || 'file', "C0AUT94D3NK", lineName, LINE_ACCESS_TOKEN_OFFICIAL);
  }
  if (event.message.type === 'sticker') {
    safeSlackPost("C0AUT94D3NK", `<!channel>\n名前：${lineName}\n内容：【スタンプ】`, "公式LINEスタンプからSlack転送");
  }
}

function handleStudentLine(userId, message, sheet, values, event) {
  const profile = UrlFetchApp.fetch(
    "https://api.line.me/v2/bot/profile/" + userId,
    { headers: { "Authorization": "Bearer " + LINE_ACCESS_TOKEN_STUDENT }, muteHttpExceptions: true }
  );
  if (profile.getResponseCode() !== 200) {
    notifyApiError('LINE', '生徒LINEプロフィール取得', userId, profile);
    return;
  }
  const lineName = JSON.parse(profile.getContentText()).displayName;

  let finalName     = lineName;
  let targetChannel = DEFAULT_CHANNEL;
  let found         = false;

  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === userId) {
      sheet.getRange(i + 1, 2).setValue(lineName);
      if (values[i][2]) { finalName = values[i][2]; targetChannel = values[i][2]; }
      found = true;
      break;
    }
  }
  if (!found) sheet.appendRow([userId, lineName]);

  if (event.message.type === 'text') {
    // 1回目：channel_not_found は想定内のためエラー通知なしで試す
    let response = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: { 'Authorization': 'Bearer ' + SLACK_BOT_TOKEN },
      payload: JSON.stringify({ channel: "#" + targetChannel, text: "<!channel>\n名前：" + finalName + "\n内容：" + message }),
      muteHttpExceptions: true
    });
    let result = {};
    try { result = JSON.parse(response.getContentText() || '{}'); } catch(e) {}

    if (!result.ok && result.error === "channel_not_found" && finalName) {
      const cleanName = finalName.replace(/\s/g, "");
      const res = UrlFetchApp.fetch(
        "https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=1000",
        { headers: { "Authorization": "Bearer " + SLACK_BOT_TOKEN }, muteHttpExceptions: true }
      );
      if (res.getResponseCode() !== 200) notifyApiError('Slack', 'conversations.list', finalName, res);
      const listBody = JSON.parse(res.getContentText() || '{}');
      if (!listBody.ok) notifyApiError('Slack', 'conversations.list', finalName, res);
      const channels = listBody.channels || [];
      for (let ch of channels) {
        if (ch.name.replace(/\s/g, "").includes(cleanName)) { targetChannel = ch.name; break; }
      }
      // 2回目以降はエラー通知あり
      response = sendToSlack(targetChannel, finalName, message);
      result   = JSON.parse(response.getContentText());
    }

    if (!result.ok) sendToSlack(DEFAULT_CHANNEL, finalName, message);
  }
  if (event.message.type === 'image')   transferLineImageToSlack(event.message.id, targetChannel, finalName, LINE_ACCESS_TOKEN_STUDENT);
  if (event.message.type === 'file')    transferLineFileToSlack(event.message.id, event.message.fileName || 'file', targetChannel, finalName, LINE_ACCESS_TOKEN_STUDENT);
  if (event.message.type === 'sticker') sendToSlack(targetChannel, finalName, "【スタンプ】");
  // Q&A ボット返信（生徒）- 「質問」で始まるメッセージのみ
  if (event.message.type === 'text' && message.trim().startsWith('質問')) {
    try {
      const answer = getRagAnswer_(message);
      safeLinePush(userId, answer, LINE_ACCESS_TOKEN_STUDENT, 'Q&Aボット返信（生徒）');
    } catch (botErr) { Logger.log('Q&Aボットエラー(生徒): ' + botErr); }
  }
}

function handleParentLine(userId, message, sheet, values, event) {
  const profile = UrlFetchApp.fetch(
    "https://api.line.me/v2/bot/profile/" + userId,
    { headers: { "Authorization": "Bearer " + LINE_ACCESS_TOKEN_PARENT }, muteHttpExceptions: true }
  );
  if (profile.getResponseCode() !== 200) {
    notifyApiError('LINE', '保護者LINEプロフィール取得', userId, profile);
    return;
  }
  const displayName = JSON.parse(profile.getContentText()).displayName;

  let studentName = "";
  let foundInE    = false;
  for (let i = 1; i < values.length; i++) {
    if (values[i][4] === userId) {
      studentName = String(values[i][6] || "").trim();
      sheet.getRange(i + 1, 6).setValue(displayName);
      foundInE = true;
      break;
    }
  }
  if (!foundInE) {
    for (let i = 1; i < values.length; i++) {
      if (!values[i][4] || String(values[i][4]).trim() === "") {
        sheet.getRange(i + 1, 5).setValue(userId);
        sheet.getRange(i + 1, 6).setValue(displayName);
        break;
      }
    }
  }

  const name = studentName ? studentName + "　親" : displayName;

  if (event.message.type === 'text') {
    safeSlackPost(PARENT_CHANNEL_ID, "<!channel>\n名前：" + name + "\n内容：" + message, "保護者LINEからSlack転送");
  }
  if (event.message.type === 'image') {
    transferLineImageToSlack(event.message.id, PARENT_CHANNEL_ID, name, LINE_ACCESS_TOKEN_PARENT);
  }
  if (event.message.type === 'file') {
    transferLineFileToSlack(event.message.id, event.message.fileName || 'file', PARENT_CHANNEL_ID, name, LINE_ACCESS_TOKEN_PARENT);
  }
  if (event.message.type === 'sticker') {
    safeSlackPost(PARENT_CHANNEL_ID, "<!channel>\n名前：" + name + "\n内容：【スタンプ】", "保護者LINEスタンプからSlack転送");
  }
  // Q&A ボット返信（保護者）- 「質問」で始まるメッセージのみ
  if (event.message.type === 'text' && message.trim().startsWith('質問')) {
    try {
      const answer = getRagAnswer_(message);
      safeLinePush(userId, answer, LINE_ACCESS_TOKEN_PARENT, 'Q&Aボット返信（保護者）');
    } catch (botErr) { Logger.log('Q&Aボットエラー(保護者): ' + botErr); }
  }
}

// ─── ファイル転送 ────────────────────────────────────────────────────────────

function transferLineImageToSlack(messageId, channel, senderName, token) {
  try {
    const lineRes = UrlFetchApp.fetch(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      { headers: { 'Authorization': `Bearer ${token}` }, muteHttpExceptions: true }
    );
    if (lineRes.getResponseCode() !== 200) {
      notifyApiError('LINE', 'LINE画像取得', messageId, lineRes);
      return;
    }
    const folder    = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    const driveFile = folder.createFile(lineRes.getBlob().setName(`line_image_${messageId}.jpg`));
    driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    safeSlackPost(channel, `【${senderName}】から画像が届きました📷\n${driveFile.getUrl()}`, 'LINE画像をSlack転送');
  } catch (err) {
    Logger.log('画像転送エラー: ' + err);
    notifyApiError('LINE/Slack', '画像転送エラー', senderName, null, String(err));
  }
}

function transferLineFileToSlack(messageId, fileName, channel, senderName, token) {
  try {
    const lineRes = UrlFetchApp.fetch(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      { headers: { 'Authorization': `Bearer ${token}` }, muteHttpExceptions: true }
    );
    if (lineRes.getResponseCode() !== 200) {
      notifyApiError('LINE', 'LINEファイル取得', messageId, lineRes);
      return;
    }
    const folder    = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    const driveFile = folder.createFile(lineRes.getBlob().setName(fileName));
    driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    safeSlackPost(channel, `【${senderName}】からファイルが届きました📄\nファイル名：${fileName}\n${driveFile.getUrl()}`, 'LINEファイルをSlack転送');
  } catch (err) {
    Logger.log('ファイル転送エラー: ' + err);
    notifyApiError('LINE/Slack', 'ファイル転送エラー', senderName, null, String(err));
  }
}

// ─── Slack → LINE転送 ────────────────────────────────────────────────────────

function handleSlackToLine(event) {
  const text          = event.text || "";
  const isBothMode    = text.includes("全員");
  const isParentMode  = text.includes("保護者") && !isBothMode;
  const isStudentMode = !isParentMode && !isBothMode;

  const cleanMessage = text
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/転送|保護者|全員/g, "")
    .trim();

  const profileRes = UrlFetchApp.fetch(
    "https://slack.com/api/users.info?user=" + event.user,
    { headers: { "Authorization": "Bearer " + SLACK_BOT_TOKEN }, muteHttpExceptions: true }
  );
  if (profileRes.getResponseCode() !== 200) { notifyApiError('Slack', 'users.info', event.user, profileRes); return; }
  const profileBody = JSON.parse(profileRes.getContentText() || '{}');
  if (!profileBody.ok) { notifyApiError('Slack', 'users.info', event.user, profileRes); return; }
  const senderName = profileBody.user.real_name || "スタッフ";

  const chRes = UrlFetchApp.fetch(
    "https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=1000",
    { headers: { "Authorization": "Bearer " + SLACK_BOT_TOKEN }, muteHttpExceptions: true }
  );
  if (chRes.getResponseCode() !== 200) { notifyApiError('Slack', 'conversations.list', event.channel, chRes); return; }
  const chBody = JSON.parse(chRes.getContentText() || '{}');
  if (!chBody.ok) { notifyApiError('Slack', 'conversations.list', event.channel, chRes); return; }
  const channels    = chBody.channels || [];
  let   channelName = null;
  for (let ch of channels) { if (ch.id === event.channel) { channelName = ch.name; break; } }
  if (!channelName) return;

  const sheet  = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(LINE_SHEET_NAME);
  const values = sheet.getDataRange().getValues();
  let studentLineId = null;
  let parentLineId  = null;

  for (let i = 1; i < values.length; i++) {
    const cleanCh = channelName.replace(/\s/g, "");
    if (!studentLineId) {
      const studentName = (values[i][2] || "").replace(/\s/g, "");
      if (studentName !== "" && cleanCh.includes(studentName)) studentLineId = values[i][0];
    }
    if (!parentLineId) {
      const parentStudentName = (values[i][6] || "").replace(/\s/g, "");
      if (parentStudentName !== "" && cleanCh.includes(parentStudentName)) parentLineId = values[i][4];
    }
    if (studentLineId && parentLineId) break;
  }

  if (!studentLineId && !parentLineId) {
    safeSlackPost(event.channel, "⚠️ LINE ID不明のため転送できませんでした。", "SlackからLINE転送: LINE ID不明通知");
    return;
  }

  if (cleanMessage) {
    const msg = cleanMessage + "（" + senderName + "）";
    if (isStudentMode || isBothMode) {
      if (studentLineId) safeLinePush(studentLineId, msg, LINE_ACCESS_TOKEN_STUDENT, "Slackから生徒LINE転送");
    }
    if (isParentMode || isBothMode) {
      if (parentLineId)  safeLinePush(parentLineId,  msg, LINE_ACCESS_TOKEN_PARENT,  "Slackから保護者LINE転送");
    }
  }

  let fileIds = (event.files || []).map(f => f.id).filter(Boolean);
  if (fileIds.length === 0 && event.file_id)               fileIds = [event.file_id];
  if (fileIds.length === 0 && event.file && event.file.id) fileIds = [event.file.id];

  for (const fileId of fileIds) {
    try {
      const infoRes  = UrlFetchApp.fetch("https://slack.com/api/files.info?file=" + fileId, { headers: { "Authorization": "Bearer " + SLACK_BOT_TOKEN }, muteHttpExceptions: true });
      const fileInfo = JSON.parse(infoRes.getContentText() || '{}');
      if (infoRes.getResponseCode() !== 200 || !fileInfo.ok) { notifyApiError('Slack', 'files.info', fileId, infoRes); continue; }

      const file        = fileInfo.file;
      const downloadUrl = file.url_private_download || file.url_private;
      const fileRes     = UrlFetchApp.fetch(downloadUrl, { headers: { "Authorization": "Bearer " + SLACK_BOT_TOKEN }, muteHttpExceptions: true });
      if (fileRes.getResponseCode() !== 200) { notifyApiError('Slack', 'SlackファイルDL', fileId, fileRes); continue; }

      const folder    = DriveApp.getFolderById(DRIVE_FOLDER_ID);
      const driveFile = folder.createFile(fileRes.getBlob().setName(file.name));
      driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      const fileMsg = `【${senderName}】からファイルが届きました📄\nファイル名：${file.name}\n${driveFile.getUrl()}`;

      if (isStudentMode || isBothMode) {
        if (studentLineId) safeLinePush(studentLineId, fileMsg, LINE_ACCESS_TOKEN_STUDENT, "SlackファイルをLINE転送(生徒)");
      }
      if (isParentMode || isBothMode) {
        if (parentLineId)  safeLinePush(parentLineId,  fileMsg, LINE_ACCESS_TOKEN_PARENT,  "SlackファイルをLINE転送(保護者)");
      }
    } catch (err) {
      Logger.log("ファイル転送エラー: " + err);
      notifyApiError('LINE/Slack', 'SlackファイルをLINE転送', fileId, null, String(err));
      safeSlackPost(event.channel, "⚠️ ファイルの転送に失敗しました：" + fileId + "\n" + err, "Slackファイル転送失敗通知");
    }
  }
}

// ─── チェックイン/アウト ──────────────────────────────────────

function checkCheckin() {
  syncStudentLineIds();
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const sheet     = ss.getSheetByName(SHEET_NAME);
  const data      = sheet.getDataRange().getValues();
  const today     = getTodayStr();
  const dayOfWeek = getTodayDayOfWeek();
  const now       = new Date();
  const nowMin    = now.getHours() * 60 + now.getMinutes();

  for (let i = 1; i < data.length; i++) {
    const name       = String(data[i][COL.NAME]).trim();
    const targetDays = String(data[i][COL.DAY_OF_WEEK]);
    if (!name || targetDays.indexOf(dayOfWeek) === -1) continue;
    if (String(data[i][COL.ABSENT]).trim() === '休') continue;

    // ── 登校済みの場合 ──
    if (data[i][COL.CHECKIN]) {
      sheet.getRange(i + 1, COL.NAME + 1).setBackground(null);

      if (data[i][COL.PARENT_CHECKIN_NOTIF] !== '通知済') {
        const checkinTime = data[i][COL.CHECKIN] instanceof Date
          ? Utilities.formatDate(data[i][COL.CHECKIN], 'Asia/Tokyo', 'HH:mm')
          : String(data[i][COL.CHECKIN]).trim();
        const parentId = String(data[i][COL.PARENT_LINE_ID] || "").trim();
        if (parentId.length > 10) {
          const ok = sendLineChecked(
            parentId,
            `【${SCHOOL_NAME}】\n${name}さんが${checkinTime}に登校しました。`,
            LINE_ACCESS_TOKEN_PARENT,
            name,
            '登校通知（保護者）'
          );
          if (ok) sheet.getRange(i + 1, COL.PARENT_CHECKIN_NOTIF + 1).setValue('通知済');
        }
      }
      continue;
    }

    // ── Gmailで登校メール確認 ──
    const threads = GmailApp.search(`subject:(${name} 登校お知らせ) after:${today}`);
    if (threads.length > 0) {
      const timeStr = Utilities.formatDate(threads[0].getMessages()[0].getDate(), 'Asia/Tokyo', 'HH:mm');
      sheet.getRange(i + 1, COL.CHECKIN + 1).setValue(timeStr);
      sheet.getRange(i + 1, COL.NAME + 1).setBackground(null);
      const parentId = String(data[i][COL.PARENT_LINE_ID] || "").trim();
      if (parentId.length > 10 && data[i][COL.PARENT_CHECKIN_NOTIF] !== '通知済') {
        const ok = sendLineChecked(
          parentId,
          `【${SCHOOL_NAME}】\n${name}さんが${timeStr}に登校しました。`,
          LINE_ACCESS_TOKEN_PARENT,
          name,
          '登校通知（保護者・Gmail検出）'
        );
        if (ok) sheet.getRange(i + 1, COL.PARENT_CHECKIN_NOTIF + 1).setValue('通知済');
      }
      continue;
    }

    // ── 遅刻チェック ──
    const promiseMin = timeToMinutes(data[i][COL.PROMISE_IN]);
    if (!isNaN(promiseMin) && nowMin - promiseMin >= 10) {
      sheet.getRange(i + 1, COL.NAME + 1).setBackground('#ffcccc');

      if (data[i][COL.STUDENT_LATE_NOTIF] !== '通知済') {
        const promiseTime = String(data[i][COL.PROMISE_IN] instanceof Date
          ? Utilities.formatDate(data[i][COL.PROMISE_IN], 'Asia/Tokyo', 'HH:mm')
          : data[i][COL.PROMISE_IN]).trim();

        // Slack通知はLINE成否に関わらず1回だけ飛ばす
        safeSlackPost("C0ASW4BLDSB", `⚠️ ${name}さんが約束時間（${promiseTime}）から10分経過しましたが未登校です。`, "未登校Slack通知");

        const ok = sendLineChecked(
          data[i][COL.STUDENT_LINE_ID],
          `【${SCHOOL_NAME}】\n${name}さん、約束から10分経ちました。自習室に来てください！`,
          LINE_ACCESS_TOKEN_STUDENT,
          name,
          '遅刻通知（生徒）'
        );
        if (ok) {
          sheet.getRange(i + 1, COL.STUDENT_LATE_NOTIF + 1).setValue('通知済');
        }
      }

      if (data[i][COL.PARENT_LATE_NOTIF] !== '通知済' && String(data[i][COL.PARENT_LINE_ID]).length > 10) {
        const ok = sendLineChecked(
          data[i][COL.PARENT_LINE_ID],
          `【${SCHOOL_NAME}】\n${name}さんが約束時間から10分経ちましたが未登校です。`,
          LINE_ACCESS_TOKEN_PARENT,
          name,
          '遅刻通知（保護者）'
        );
        if (ok) sheet.getRange(i + 1, COL.PARENT_LATE_NOTIF + 1).setValue('通知済');
      }
    }
  }
}

function checkCheckout() {
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const sheet     = ss.getSheetByName(SHEET_NAME);
  const data      = sheet.getDataRange().getValues();
  const today     = getTodayStr();
  const dayOfWeek = getTodayDayOfWeek();
  const now       = new Date();
  const nowMin    = now.getHours() * 60 + now.getMinutes();

  for (let i = 1; i < data.length; i++) {
    const name = String(data[i][COL.NAME]).trim();
    if (!name || String(data[i][COL.DAY_OF_WEEK]).indexOf(dayOfWeek) === -1) continue;
    if (!data[i][COL.CHECKIN]) continue;
    if (String(data[i][COL.ABSENT]).trim() === '休') continue;

    // ── Gmailで下校メール確認 ──
    if (!data[i][COL.CHECKOUT]) {
      const threads = GmailApp.search(`subject:(${name} 下校お知らせ) after:${today}`);
      if (threads.length > 0) {
        const timeStr = Utilities.formatDate(threads[0].getMessages()[0].getDate(), 'Asia/Tokyo', 'HH:mm');
        sheet.getRange(i + 1, COL.CHECKOUT + 1).setValue(timeStr);
        if (String(data[i][COL.PARENT_LINE_ID]).length > 10) {
          const ok = sendLineChecked(
            data[i][COL.PARENT_LINE_ID],
            `【${SCHOOL_NAME}】\n${name}さんが${timeStr}に下校しました。`,
            LINE_ACCESS_TOKEN_PARENT,
            name,
            '下校通知（保護者）'
          );
          if (ok) sheet.getRange(i + 1, COL.PARENT_OUT_NOTIF + 1).setValue('退校通知済');
        }
      }
    }

    // ── 終了時間前通知 ──
    const endMin = timeToMinutes(data[i][COL.PROMISE_OUT]);
    if (!data[i][COL.CHECKOUT] &&
        !isNaN(endMin) &&
        nowMin >= endMin - 10 &&
        nowMin <= endMin - 5 &&
        data[i][COL.STUDENT_OUT_NOTIF] !== '退校通知済') {
      const ok = sendLineChecked(
        data[i][COL.STUDENT_LINE_ID],
        `【${SCHOOL_NAME}】\n${name}さん、まもなく終了時間です。今日の反省を記入して社員に提出してから帰りましょう。お疲れ様でした！`,
        LINE_ACCESS_TOKEN_STUDENT,
        name,
        '終了時間前通知（生徒）'
      );
      if (ok) sheet.getRange(i + 1, COL.STUDENT_OUT_NOTIF + 1).setValue('退校通知済');
    }
  }
}

// ─── スプレッドシートユーティリティ ─────────────────────────────────────────

function resetDailyFlags() {
  const sheet   = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const numRows = lastRow - 1;
  sheet.getRange(2, COL.CHECKIN + 1, numRows, 1).clearContent();
  sheet.getRange(2, COL.CHECKOUT + 1, numRows, 1).clearContent();
  sheet.getRange(2, COL.PARENT_CHECKIN_NOTIF + 1, numRows, 5).clearContent();
  sheet.getRange(2, COL.NAME + 1, numRows, 1).setBackground(null);
  PropertiesService.getScriptProperties().getKeys()
    .filter(k => k.startsWith('fail_notif_'))
    .forEach(k => PropertiesService.getScriptProperties().deleteProperty(k));
}

function syncStudentLineIds() {
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const master    = ss.getSheetByName(SHEET_NAME);
  const lineSheet = ss.getSheetByName(LINE_SHEET_NAME);
  const mData     = master.getDataRange().getValues();
  const lData     = lineSheet.getDataRange().getValues();

  const studentIdMap = {};
  lData.forEach(r => { if (r[2] && r[0]) studentIdMap[String(r[2]).replace(/\s/g, '')] = String(r[0]); });
  const parentIdMap = {};
  lData.forEach(r => { if (r[6] && r[4]) parentIdMap[String(r[6]).replace(/\s/g, '')] = String(r[4]); });

  for (let i = 1; i < mData.length; i++) {
    const name = String(mData[i][COL.NAME]).replace(/\s/g, '');
    if (!name) {
      master.getRange(i + 1, COL.STUDENT_LINE_ID + 1).clearContent();
      master.getRange(i + 1, COL.PARENT_LINE_ID + 1).clearContent();
    } else {
      if (studentIdMap[name]) master.getRange(i + 1, COL.STUDENT_LINE_ID + 1).setValue(studentIdMap[name]);
      if (parentIdMap[name])  master.getRange(i + 1, COL.PARENT_LINE_ID + 1).setValue(parentIdMap[name]);
    }
  }
}

function isDuplicate(spreadsheetId, eventId) {
  const ss    = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetByName("イベントID");
  if (!sheet) return false;
  return sheet.getDataRange().getValues().some(row => row[0] === eventId);
}

function saveEventId(spreadsheetId, eventId) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  let sheet = ss.getSheetByName("イベントID");
  if (!sheet) sheet = ss.insertSheet("イベントID");
  sheet.appendRow([eventId, new Date()]);
  const lastRow = sheet.getLastRow();
  if (lastRow > 500) sheet.deleteRows(1, 500);
}

function sendToSlack(channel, name, message) {
  return safeSlackPost("#" + channel, "<!channel>\n名前：" + name + "\n内容：" + message, "sendToSlack");
}

function timeToMinutes(val) {
  if (val instanceof Date)     return val.getHours() * 60 + val.getMinutes();
  if (typeof val === 'number') return Math.floor(val * 24 * 60);
  const p = String(val).split(':');
  return p.length < 2 ? NaN : parseInt(p[0]) * 60 + parseInt(p[1]);
}

function getTodayStr() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd');
}

function getTodayDayOfWeek() {
  const val = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME).getRange('A1').getValue();
  const m   = String(val).match(/\(([日月火水木金土])\)/);
  return m ? m[1] : ['日','月','火','水','木','金','土'][new Date().getDay()];
}

function sendLineWithToken(to, msg, token) {
  return safeLinePush(to, msg, token, 'sendLineWithToken');
}

function upsertOfficialLineUser_(userId, displayName) {
  const ss     = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet  = ss.getSheetByName(LINE_SHEET_NAME);
  const values = sheet.getDataRange().getValues();
  const uid    = String(userId || '').trim();
  const name   = String(displayName || '').trim();
  if (!uid) return;

  const COL_UID  = 9;
  const COL_NAME = 10;

  for (let i = 1; i < values.length; i++) {
    const existing = String(values[i][COL_UID - 1] || '').trim();
    if (existing && existing === uid) {
      sheet.getRange(i + 1, COL_NAME).setValue(name || values[i][COL_NAME - 1]);
      return;
    }
  }

  let targetRow = -1;
  for (let i = 1; i < values.length; i++) {
    const iCol = String(values[i][COL_UID - 1] || '').trim();
    const jCol = String(values[i][COL_NAME - 1] || '').trim();
    if (!iCol && !jCol) { targetRow = i + 1; break; }
  }
  if (targetRow < 0) targetRow = sheet.getLastRow() + 1;
  sheet.getRange(targetRow, COL_UID).setValue(uid);
  sheet.getRange(targetRow, COL_NAME).setValue(name);
}

// ─── トリガー管理 ────────────────────────────────────────────────────────────

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkCheckin').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('checkCheckout').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('resetDailyFlags').timeBased().atHour(0).nearMinute(0).everyDays(1).create();
}

function cleanupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
}


// ─── RAG Q&Aボット ──────────────────────────────────────────────────────────

function getRagAnswer_(userMessage) {
  try {
    // 1. クエリをベクトル化
    const queryEmb = embedText_(userMessage);
    if (!queryEmb) return '校舎にお問い合わせください。';

    // 2. 知識ベース（埋め込み済みチャンク）をDriveから読み込み
    const chunks = loadEmbeddings_();
    if (!chunks || chunks.length === 0) return '校舎にお問い合わせください。';

    // 3. 類似度上位5件を取得
    const topChunks = getTopK_(queryEmb, chunks, 5);
    Logger.log('RAG top chunk: ' + topChunks[0].text.substring(0, 80) + ' (sim=' + topChunks[0].sim.toFixed(3) + ')');

    // 4. 上位チャンクを文脈としてGeminiに渡す
    const context = topChunks.map(function(c) { return c.text; }).join('\n\n---\n\n');
    return askGeminiWithContext_(userMessage, context);
  } catch (e) {
    Logger.log('getRagAnswer_エラー: ' + e);
    return '校舎にお問い合わせください。';
  }
}

function embedText_(text) {
  var endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent';
  var payload  = { content: { parts: [{ text: text }] } };
  var options  = {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true,
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

function loadEmbeddings_() {
  try {
    var file = DriveApp.getFileById(EMBEDDINGS_FILE_ID);
    var json = file.getBlob().getDataAsString('UTF-8');
    return JSON.parse(json);
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

function getTopK_(queryEmb, chunks, k) {
  var qNorm = norm_(queryEmb);
  var scored = chunks.map(function(c) {
    var sim = dotProduct_(queryEmb, c.emb) / (qNorm * norm_(c.emb));
    return { text: c.text, page_id: c.page_id, sim: sim };
  });
  scored.sort(function(a, b) { return b.sim - a.sim; });
  return scored.slice(0, k);
}

function askGeminiWithContext_(userMessage, context) {
  var endpoint = 'https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-lite:generateContent';
  var prompt =
    'あなたは塾のAIアシスタントです。' +
    '以下の参考情報に基づいて質問に回答してください。\n' +
    '参考情報に答えがない場合は「校舎にお問い合わせください」と答えてください。\n' +
    'このボットは生徒・保護者向けのLINEサポートです。\n' +
    '回答は必ず生徒・保護者の視点で書いてください。\n' +
    'スタッフ・校舎向けの内部業務情報（boxへのアップロード、社内システム操作手順、本部への申請フロー、社内申請書類の処理方法など）は絶対に回答に含めないでください。\n' +
    '生徒・保護者が行うべき手続きや確認事項のみを案内してください。\n' +
    '回答はMarkdownやHTMLを使わず、プレーンテキストで書いてください。\n' +
    '箇条書きは「・」を使ってください。括弧内の詳細情報も省略せずに記載してください。太字・見出しは使わないでください。\n' +
    '各箇条書き項目の後に空行を1行入れてください。\n' +
    'ファイル名・PDF名・URLは回答に含めないでください。\n\n' +
    '=== 参考情報 ===\n' + context + '\n===============\n\n' +
    '質問: ' + userMessage;
  var payload = { contents: [{ parts: [{ text: prompt }] }] };
  var options = {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true,
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
    Logger.log('Top' + (i+1) + ' (sim=' + c.sim.toFixed(3) + '): ' + c.text.substring(0, 100));
  });

  var start = new Date().getTime();
  var answer = getRagAnswer_(question);
  var elapsed = ((new Date().getTime() - start) / 1000).toFixed(1);
  Logger.log('回答 (' + elapsed + '秒): ' + answer);
}

