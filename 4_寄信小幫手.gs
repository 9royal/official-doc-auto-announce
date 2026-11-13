/**
 * 寄信小幫手 1.1（公文自動公告系統 v10.1）
 *
 * 裝在「寄件帳號」（公文自動公告系統 CONFIG.MAIL_SENDER 那個學校信箱）的 Apps Script。
 * 每 5 分鐘讀一次公文自動公告系統的「寄信佇列（公文自動公告）」試算表，
 * 把「待寄」的信用這個帳號寄出，再把結果寫回去（已寄／失敗）。
 *
 * 安裝（用寄件帳號登入）：
 *   1. script.google.com → 新專案，改名「寄信小幫手」，貼上這整份程式，存檔。
 *   2. 函式選 setup → 執行 → 授權（進階 → 前往（不安全）→ 允許）。
 *      setup 會找到分享給你的寄信佇列、裝好每 5 分鐘的排程，並先跑一次。
 *   3. 想先試寄：執行 testSend，會寄一封測試信給自己。
 *   只能裝一份：要換新版就貼到同一個專案；另一個專案還在跑時，這份不會寄信（避免同一封寄兩次）。
 *
 * 安全：
 *   - 只寄給學校網域（ALLOWED_DOMAIN）的信箱，一封最多 MAX_RECIPIENTS 個；收件群組在審核台「管理群組」增減，這裡不用改；
 *     附件只能是公文自動公告「02_待審核／03_已發布」底下公文資料夾裡的檔案（setup 時記下這兩個資料夾）。
 *   - 佇列試算表的共用：setup 時記下可以編輯的人；之後多了別人，或開成「知道連結的人可以編輯」就不寄。
 *   - 一封信一旦呼叫過寄信，就不會自動重寄（可能已經寄出）；中斷的改成失敗、請人到寄件備份確認。
 *   - 排進佇列超過 EXPIRE_HOURS 還沒寄的不補寄（過時的通知）。
 *   - 不存任何密碼或金鑰。
 */

const HELPER = {
  VERSION: '1.1',
  QUEUE_NAME: '寄信佇列（公文自動公告）',
  ALLOWED_DOMAIN: 'example.com',   // 【布建時看這裡】學校信箱網域，跟系統的 CONFIG.MAIL_DOMAIN 一樣
  MAX_RECIPIENTS: 50,        // Apps Script 一封信最多 50 個收件者
  MAX_ATTEMPTS: 3,           // 寄出前的暫時性錯誤（例如雲端硬碟一時讀不到）最多試幾次
  MAX_MB: 20,
  SENDING_STALE_MIN: 15,     // 「寄送中」超過幾分鐘當成中斷
  EXPIRE_HOURS: 12,
  BUDGET_MS: 4 * 60 * 1000   // 一輪最多跑多久（Apps Script 單次上限 6 分鐘）
};

/** 一次設定：找佇列、裝排程、先跑一次 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('QUEUE_ID');
  if (!id) {
    const it = DriveApp.searchFiles('title = "' + HELPER.QUEUE_NAME + '" and mimeType = "application/vnd.google-apps.spreadsheet" and trashed = false');
    const found = [];
    while (it.hasNext()) found.push(it.next());
    if (found.length !== 1) {
      throw new Error(found.length
        ? '找到 ' + found.length + ' 份「' + HELPER.QUEUE_NAME + '」，請到「專案設定 → 指令碼屬性」新增 QUEUE_ID，值填正確那份試算表網址中 /d/ 後面那串。'
        : '找不到分享給你的「' + HELPER.QUEUE_NAME + '」。請先在公文自動公告系統執行 setupMail（會自動分享給這個帳號），再回來執行 setup。');
    }
    id = found[0].getId();
    props.setProperty('QUEUE_ID', id);
  }
  const ss = SpreadsheetApp.openById(id);   // 確認打得開
  // 記下附件資料夾（公文自動公告 setupMail 寫在「狀態」第 6 列）與目前可以編輯佇列的人
  const parents = String(unq_((ss.getSheetByName('狀態') || { getRange: function () { return { getValue: function () { return ''; } }; } })
    .getRange(6, 2).getValue()) || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  if (parents.length !== 2) throw new Error('寄信佇列的「狀態」工作表沒有附件資料夾，請先在公文自動公告系統重新執行 setupMail。');
  props.setProperty('ALLOWED_PARENTS', parents.join(','));
  const editors = currentEditors_(id);
  props.setProperty('ALLOWED_EDITORS', editors.join(','));
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendPending') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendPending').timeBased().everyMinutes(5).create();
  const n = sendPending();
  const msg = '已連上寄信佇列並裝好每 5 分鐘的排程（寄件帳號 ' + Session.getEffectiveUser().getEmail() + '）。這一輪寄出 ' + n + ' 封。\n' +
              '目前可以編輯寄信佇列的人：' + editors.join('、') + '。請確認只有你自己的帳號；之後多了別人，小幫手會停止寄信。';
  Logger.log(msg);
  return msg;
}

/** 寄一封測試信給自己，確認這個帳號能寄信 */
function testSend() {
  const me = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({ to: me, subject: '寄信小幫手測試', body: '寄信小幫手可以用這個帳號寄信了。\n\n' + new Date() });
  Logger.log('已寄測試信給 ' + me);
}

/** 停用排程 */
function pause() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendPending') ScriptApp.deleteTrigger(t);
  });
  Logger.log('已停用寄信小幫手的排程；要恢復請再執行 setup。');
}

/** 排程每 5 分鐘：寄出「待寄」的信。回傳這一輪寄出幾封 */
function sendPending() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 0;
  const t0 = Date.now();
  let sent = 0;
  try {
    const ss = SpreadsheetApp.openById(queueId_());
    if (!beat_(ss)) return 0;                     // 另一個小幫手專案正在跑：不寄
    const warn = editorsProblem_();
    warn_(ss, warn);
    if (warn) return 0;                           // 佇列有別人可以編輯：不寄，審核台會顯示原因
    const q = ss.getSheetByName('佇列');
    const last = q.getLastRow();
    if (last < 2) return 0;
    const head = q.getRange(1, 1, 1, q.getLastColumn()).getValues()[0];
    const col = function (k) {
      const i = head.indexOf(k);
      if (i < 0) throw new Error('寄信佇列少了「' + k + '」欄，請不要改動標題列');
      return i + 1;
    };
    const vals = q.getRange(2, 1, last - 1, head.length).getValues();
    const get = function (v, k) { return unq_(v[col(k) - 1]); };
    const cell = function (row, k) { return q.getRange(row, col(k)); };
    const put = function (row, k, val) { cell(row, k).setValue(val); };
    // 寫回前確認這一列還是同一封信（有人手動刪列、排序會讓列號移動，免得寫到別封）
    const same = function (row, id) { return String(unq_(cell(row, '寄信ID').getValue())) === id; };

    for (let i = 0; i < vals.length; i++) {
      if (Date.now() - t0 > HELPER.BUDGET_MS) break;
      const row = i + 2;
      const v = vals[i];
      const st = String(get(v, '狀態'));
      const mailId = String(get(v, '寄信ID'));

      // 上一輪寄到一半被中斷：可能已經寄出，不自動重寄
      if (/^寄送中/.test(st)) {
        const began = new Date(get(v, '開始時間')).getTime();
        if ((!began || Date.now() - began > HELPER.SENDING_STALE_MIN * 60 * 1000) && same(row, mailId)) {
          put(row, '狀態', '失敗');
          put(row, '結果', '寄送中斷，可能已經寄出：請到寄件備份確認，真的沒寄出再到審核台按「重新寄送」');
        }
        continue;
      }
      if (st !== '待寄') continue;

      // 太舊的不補寄（小幫手停太久，例如「明天開會」的通知幾天後才寄出）
      const made = new Date(get(v, '建立時間')).getTime();
      if (made && Date.now() - made > HELPER.EXPIRE_HOURS * 3600 * 1000) {
        if (!same(row, mailId)) continue;
        put(row, '狀態', '失敗');
        put(row, '結果', '排進佇列超過 ' + HELPER.EXPIRE_HOURS + ' 小時還沒寄出，已不寄（過時）；還要寄請到審核台按「重新寄送」');
        continue;
      }

      // 認領：重讀這一列（不用一開始的快照：審核台可能剛取消、有人刪列讓列號移動），寫上自己的記號，等一下再確認還是自己的
      const still = function (want) {
        return same(row, mailId) && String(unq_(cell(row, '狀態').getValue())) === want;
      };
      if (!still('待寄')) continue;
      const token = '寄送中:' + Math.random().toString(36).slice(2, 8);
      put(row, '狀態', token);
      put(row, '開始時間', new Date());
      SpreadsheetApp.flush();
      Utilities.sleep(1500);
      if (!still(token)) continue;                   // 被取消、被別人認領、或列號變了

      const tries = Number(get(v, '嘗試次數') || 0) + 1;
      put(row, '嘗試次數', tries);

      // 寄出前的檢查與準備：失敗可以安全重試（還沒寄）
      let opt;
      try {
        opt = prepare_(v, get);
      } catch (e) {
        if (!still(token)) continue;
        const permanent = e.permanent || tries >= HELPER.MAX_ATTEMPTS;
        put(row, '狀態', permanent ? '失敗' : '待寄');
        put(row, '結果', String(e.message || e).slice(0, 300) + (permanent ? '' : '（下一輪再試）'));
        SpreadsheetApp.flush();
        continue;
      }

      // 準備附件可能要好幾秒：寄出前最後再確認一次還是自己的（審核台可能在這段時間取消）
      if (!still(token)) continue;
      // 寄出：一旦呼叫過就不自動重寄。只有「今天的寄信額度用完」確定沒寄出，留到下一輪
      try {
        MailApp.sendEmail(opt);
      } catch (e) {
        if (!same(row, mailId)) continue;
        const quota = /too many times|invoked too many|quota/i.test(String(e.message));
        put(row, '狀態', quota ? '待寄' : '失敗');
        put(row, '結果', quota ? '今天的寄信額度用完，明天再寄（' + String(e.message).slice(0, 120) + '）'
                               : '寄出時發生錯誤，可能已經寄出：請到寄件備份確認（' + String(e.message).slice(0, 200) + '）');
        SpreadsheetApp.flush();
        continue;
      }
      sent++;
      // 寫回失敗就留在「寄送中」，15 分鐘後轉成「可能已寄出」，不會重寄；列號變了就不寫（寫錯列）
      if (!same(row, mailId)) continue;
      put(row, '狀態', '已寄');
      put(row, '寄出時間', new Date());
      put(row, '結果', '已寄出' + (opt.attachments ? '，附件 ' + opt.attachments.length + ' 個' : ''));
      SpreadsheetApp.flush();
    }
  } finally {
    lock.releaseLock();
  }
  return sent;
}

/** 寄出前檢查並組好要寄的信：收件者網域、附件位置與大小 */
function prepare_(v, get) {
  const fail = function (msg) { const e = new Error(msg); e.permanent = true; return e; };
  const to = String(get(v, '收件者') || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  if (!to.length) throw fail('沒有收件者');
  if (to.length > HELPER.MAX_RECIPIENTS) throw fail('收件者太多（' + to.length + ' 個）');
  const re = new RegExp('^[^@\\s]+@' + HELPER.ALLOWED_DOMAIN.replace(/\./g, '\\.') + '$', 'i');
  const bad = to.filter(function (x) { return !re.test(x); });
  if (bad.length) throw fail('收件者不是 ' + HELPER.ALLOWED_DOMAIN + ' 的信箱：' + bad.join('、'));
  const subject = String(get(v, '標題') || '').replace(/[\r\n]+/g, ' ').trim();
  const body = String(get(v, '內文') || '').trim();
  if (!subject || !body) throw fail('標題或內文是空的');

  const ids = String(get(v, '附件ID') || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  const blobs = [];
  let bytes = 0;
  ids.forEach(function (id) {
    let f;
    try { f = DriveApp.getFileById(id); }
    catch (e) { throw new Error('讀不到附件（' + id + '）：檔案可能被移走或沒有分享給這個帳號'); }
    if (!inCaseFolder_(f)) throw fail('附件「' + f.getName() + '」不在公文資料夾裡，不寄');
    bytes += f.getSize();
    if (bytes > HELPER.MAX_MB * 1048576) throw fail('附件總大小超過 ' + HELPER.MAX_MB + ' MB');
    blobs.push(f.getBlob().setName(f.getName()));
  });

  const opt = { to: to.join(','), subject: subject, body: body };
  const html = String(get(v, '內文HTML') || '').trim();
  if (html) opt.htmlBody = html;
  if (blobs.length) opt.attachments = blobs;
  return opt;
}

/** 附件要在「公文資料夾」裡：檔案的上一層是某則公文的資料夾，再上一層是 setup 時記下的 02_待審核 或 03_已發布（比對資料夾 ID） */
function inCaseFolder_(f) {
  const allowed = String(PropertiesService.getScriptProperties().getProperty('ALLOWED_PARENTS') || '').split(',').filter(Boolean);
  if (!allowed.length) return false;
  const ps = f.getParents();
  while (ps.hasNext()) {
    const caseFolder = ps.next();
    const gs = caseFolder.getParents();
    while (gs.hasNext()) {
      if (allowed.indexOf(gs.next().getId()) >= 0) return true;
    }
  }
  return false;
}

/** 讀回來的文字：萬一 ' 前綴被存成內容，去掉 */
function unq_(v) { return typeof v === 'string' && v.charAt(0) === "'" ? v.slice(1) : v; }

/** 目前可以編輯佇列的人（含擁有者），小寫 */
function currentEditors_(id) {
  const f = DriveApp.getFileById(id);
  const out = [];
  try { if (f.getOwner()) out.push(String(f.getOwner().getEmail()).toLowerCase()); } catch (e) {}
  f.getEditors().forEach(function (u) { const e = String(u.getEmail()).toLowerCase(); if (e && out.indexOf(e) < 0) out.push(e); });
  const me = String(Session.getEffectiveUser().getEmail()).toLowerCase();
  if (out.indexOf(me) < 0) out.push(me);
  return out.filter(Boolean);
}

/**
 * 佇列的共用跟 setup 時一樣才寄：多了可以編輯的人、或開成「知道連結的人／整個網域可以編輯」→ 回傳警告
 * （別人可以往裡面塞信，用這個帳號寄出）。讀不到共用設定也先不寄（下一輪再看）。
 */
function editorsProblem_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const allowed = String(props.getProperty('ALLOWED_EDITORS') || '').split(',').filter(Boolean);
    if (!allowed.length) return '寄信小幫手還沒記下佇列的共用名單，請重新執行 setup。';
    const f = DriveApp.getFileById(queueId_());
    const access = String(f.getSharingAccess());
    const perm = String(f.getSharingPermission());
    const readOnly = [String(DriveApp.Permission.VIEW), String(DriveApp.Permission.COMMENT), String(DriveApp.Permission.NONE)];
    if (access !== String(DriveApp.Access.PRIVATE) && readOnly.indexOf(perm) < 0) {
      const name = { ANYONE: '任何人', ANYONE_WITH_LINK: '知道連結的任何人', DOMAIN: '整個網域', DOMAIN_WITH_LINK: '網域內知道連結的人' }[access] || access;
      return '寄信佇列開放「' + name + '」可以編輯，為了安全先不寄。請把一般存取權改回「限制」。';
    }
    const others = currentEditors_(f.getId()).filter(function (e) { return allowed.indexOf(e) < 0; });
    return others.length
      ? '寄信佇列多了可以編輯的人（' + others.join('、') + '），為了安全先不寄。請把他們從共用名單移除。'
      : '';
  } catch (e) {
    console.warn('讀不到寄信佇列的共用設定：' + e.message);
    return '暫時讀不到寄信佇列的共用設定，這一輪先不寄（' + String(e.message).slice(0, 80) + '）';
  }
}

/** 把警告寫到「狀態」工作表第 5 列，審核台頂端看得到；沒有警告就清空 */
function warn_(ss, msg) {
  try { (ss.getSheetByName('狀態')).getRange(5, 1, 1, 2).setValues([['警告', msg || '']]); } catch (e) {}
}

function queueId_() {
  const id = PropertiesService.getScriptProperties().getProperty('QUEUE_ID');
  if (!id) throw new Error('還沒設定寄信佇列，請先執行 setup。');
  return id;
}

/**
 * 心跳：公文自動公告的審核台看得到小幫手有沒有在跑、用哪個帳號。
 * 只能有一份小幫手在跑：另一個專案 20 分鐘內回報過，這份就不寄（回傳 false），免得同一封寄兩次。
 */
function beat_(ss) {
  const st = ss.getSheetByName('狀態') || ss.insertSheet('狀態');
  const me = ScriptApp.getScriptId();
  const cur = st.getRange(1, 2, 4, 1).getValues();
  const otherAt = cur[0][0] ? new Date(cur[0][0]).getTime() : 0;
  if (cur[3][0] && String(cur[3][0]) !== me && otherAt && Date.now() - otherAt < 20 * 60 * 1000) {
    console.warn('另一個寄信小幫手專案（' + cur[3][0] + '）正在運作，這份不寄。要換成這份，請先在舊專案執行 pause。');
    return false;
  }
  st.getRange(1, 1, 4, 2).setValues([
    ['寄信小幫手最後回報', new Date()],
    ['帳號', Session.getEffectiveUser().getEmail()],
    ['版本', HELPER.VERSION],
    ['專案', me]
  ]);
  return true;
}
