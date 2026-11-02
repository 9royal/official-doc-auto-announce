/**
 * 公文自動公告系統 — 單檔版
 * 新北市立達觀國民中小學
 *
 * 原本的 8 個 .gs 併成這一個檔，貼進 Apps Script 的程式碼檔即可。
 * 另外還需要一個 HTML 檔：新增 → HTML，檔名打 Review，貼入 Review.html 的內容。
 *
 * 指令碼屬性（專案設定 → 指令碼屬性）：
 *   ANTHROPIC_API_KEY 必填，console.anthropic.com 取得
 *   NOTIFY_EMAIL     選填，Telegram 沒設或傳不出去時改寄的信箱（沒填就寄給專案擁有者）
 *   TELEGRAM_BOT_TOKEN 選填，@BotFather 給的機器人 token；設好後執行 setupTelegram()
 *   TELEGRAM_CHAT_ID   setupTelegram() 自動填，不用手動設
 *   BRIDGE_TOKEN     選填，瀏覽器腳本的第二道檢查
 *   RPAGE_USER/PASS  目前用不到，後台登入有驗證碼
 *
 * 安裝順序：貼完兩個檔 → 設 ANTHROPIC_API_KEY → 執行 setup() → 部署網頁應用程式
 */


// ============================================================
// Config.gs
// ============================================================

/**
 * 公文自動公告系統 — 全域設定
 * 新北市立達觀國民中小學
 *
 * 敏感資料（API 金鑰、後台帳密）一律放 Script Properties，不要寫在這個檔案裡。
 * 設定路徑：Apps Script 編輯器 → 專案設定 → 指令碼屬性
 *
 * 需要的屬性：
 *   ANTHROPIC_API_KEY Claude API 金鑰（console.anthropic.com）
 *   RPAGE_USER       校網後台帳號
 *   RPAGE_PASS       校網後台密碼
 *   NOTIFY_EMAIL     Telegram 傳不出去時改寄的信箱（可留空，留空寄給專案擁有者）
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID  Telegram 通知（見 setupTelegram）
 */

// ============================================================
// 【布建時看這裡】不同學校要改的設定都在下面 CONFIG 的這幾項，
//   SCHOOL_NAME、SITE_URL、CATEGORIES、RPAGE_GROUPS、RPAGE_ALSO_POST_TO、ARCHIVE_FOLDERS
// 同一所學校（達觀）直接用，不用改。詳見安裝說明（套件裡的「安裝說明.md」，GitHub 上的 README.md）。
// ============================================================
const CONFIG = {
  SCHOOL_NAME: '新北市立達觀國民中小學',
  SITE_URL: 'https://www.dgejh.ntpc.edu.tw',

  // ---- Drive 結構 ----
  ROOT_FOLDER_NAME: '公文自動公告',
  FOLDERS: {
    INBOX:     '00_待處理',
    WORKING:   '01_處理中',
    REVIEW:    '02_待審核',
    PUBLISHED: '03_已發布',
    REJECTED:  '99_已退回'
  },

  SHEET_NAME: '公告佇列',

  // ---- Claude ----
  CLAUDE_MODEL: 'claude-sonnet-5-5',
  ANTHROPIC_BASE: 'https://api.anthropic.com/v1',
  ANTHROPIC_VERSION: '2023-06-01',
  AI_MAX_TOKENS: 4096,
  AI_EFFORT: 'low',
  MAX_INLINE_MB: 18,          // 單次請求的檔案上限
  AI_RETRY: 2,

  // ---- 校網公告分類（對應首頁頁籤，名稱要跟後台下拉選單一字不差）----
  CATEGORIES: [
    '最新消息',
    '升學專區',
    '獎助學金',
    '新生入學',
    '行政公告',
    '人才招聘',
    '教師研習',
    '達觀新聞'
  ],

  // ---- 標題前綴慣例（校網現行用法）----
  SCOPE_PREFIX: {
    '國中部': '【國中部】',
    '國小部': '【國小部】',
    '全校':   '【全校】',
    '家長':   '【家長】',
    '教師':   '【教師】'
  },

  // ---- 流程控制 ----
  AUTO_PUBLISH_ON_APPROVE: false,  // 後台登入有驗證碼，無法從 Apps Script 直接送出；
                                   // 核准後停在「待發布」，由瀏覽器腳本接手填表
  DEFAULT_POST_DAYS: 30,           // 沒抓到截止日時的預設公告天數
  EXPIRED_POST_DAYS: 7,            // 辦理期限已過的公文，迄日先訂幾天後（並提醒確認是否還要公告）
  RENAME_FILES: true,              // 解析後把公文與附件改名為「主題_西元年月日」
  RENAME_MAX_LEN: 40,              // 主題部分最多保留幾個字
  GROUP_NUMBERED_FILES: true,      // 00_待處理 的散檔以「1-1、1-2」「2-0、2-1」開頭時，前面數字相同的併成同一個公文
  INTAKE_SETTLE_MINUTES: 3,        // 最後一個檔案放進來後等幾分鐘才收件，避免還在上傳就被拆開
  UPLOAD_MAIN_DOC: true,           // 公文本體也當附件上傳校網（排在第一個）
  BLOCK_ON_RED: true,              // 個資紅燈強制擋下，不得核准

  // ---- 案件狀態 ----
  STATUS: {
    NEW:       'NEW',        // 剛收進來
    PARSING:   'PARSING',    // AI 解析中
    REVIEW:    'REVIEW',     // 待人工審核
    BLOCKED:   'BLOCKED',    // 密等或紅燈，禁止公開
    APPROVED:  'APPROVED',   // 已核准、等發布
    PUBLISHED: 'PUBLISHED',  // 已上校網
    REJECTED:  'REJECTED',   // 退回不公告
    SUBMITTING:'SUBMITTING', // 公告助手自動模式已領取，正在後台送出／等待校網出現
    ERROR:     'ERROR',
    DELETED:   'DELETED'     // 在審核台刪除：資料夾已丟到 Drive 垃圾桶，清單不再顯示（列保留做紀錄）
  },

  // ---- 黑快馬 R-page「公告模組」代號（後台：分類 → 公告 → 選擇所屬公告模組）----
  RPAGE_GROUPS: {
    '最新消息': 43, '新生入學': 78, '升學專區': 79, '榮譽榜單': 45, '獎助學金': 22,
    '教師研習': 46, '行政公告': 23, '達觀新聞': 76, '人才招聘': 80
  },
  RPAGE_ALSO_POST_TO: ['最新消息'], // 每則都同時勾選的公告模組（校網慣例：公文公告也出現在最新消息）

  // ---- 無障礙（AA）----
  AUTO_ODF: true,                  // Word/Excel/PPT 附件自動產生 ODF 版本（.odt/.ods/.odp）

  // ---- 通知 ----
  // 每則公文解析完通知「待審核／已擋下」：關掉，到審核台看就好。
  // 其他通知（處理失敗、公告助手暫停、後台登入過期、核准太久沒發布）一律走 notify_：先傳 Telegram，傳不出去改寄 email。
  NOTIFY_NEW_CASE: false,

  // ---- 審核台「歷史公文」分頁 ----
  RECENT_HOURS: 48,                // 「最近完成」只顯示幾小時內的；更早的放到「歷史公文」分頁
  // 歸檔資料夾（與學校共用雲端硬碟的資料夾名稱相同）：AI 解析時挑一個，審核台可以改
  ARCHIVE_FOLDERS: [
    '01.網路', '02.mail', '03.網路電話', '04.校務行政統+親師生平台', '04.校園通APP', '05.校網首頁',
    '06.資安', '07.虛擬機房', '08.聯廣+廣播+LED', '10.重灌相關', '11.調查表單', '12.獎狀樣板',
    '13.說明書', '14.參訪海報', '21.行政與導師會報', '22.公文與評鑑', '23.科技教育', '24.股長與志工',
    '25.填報', '26.核銷', '28.專科教室', '29.設備借用(含油印與教具室)', '30.監視器', '31.維修或復原',
    '32.停課不停學', '33.AI課程', '34.PowerTech', '35.Scratch與程式', '36.打字比賽',
    '37.IEYI世界青少年創客發明展', '38.計畫相關', '39.寒暑假作業與營隊', '40.自然領域',
    '42.局端設備配發', '43.智慧學習輔導小組', '44.數位學習精進方案', '45.AI使用、融入教學', '46.無人機'
  ],
  UNFILED: '未分類'
};

/** 佇列試算表欄位順序，改這裡會連動整個系統 */
const COLUMNS = [
  'caseId', '建立時間', '狀態', '資料夾ID',
  '發文機關', '發文字號', '發文日期', '密等', '速別',
  '主旨', '辦理期限',
  '建議分類', '公告標題', '公告內文', '適用對象',
  '公告起日', '公告迄日',
  '風險等級', '風險說明',
  '附件清單', '審核人', '審核時間', '發布時間', '校網網址', '備註',
  '歸檔分類', '公文本體ID'          // v9 新增：審核台歷史分頁的資料夾、解析時認定的公文本體
];

/** 讀取 Script Property，缺少時給出明確錯誤 */
function prop_(key, required) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v && required) {
    throw new Error(
      '缺少指令碼屬性 ' + key + '。請到「專案設定 → 指令碼屬性」新增後再執行。'
    );
  }
  return v || '';
}

function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}

/**
 * 「存過草稿」記號：記在指令碼屬性 DRAFT_<caseId>（不動試算表欄位）。
 * 審核台按「重新解析」前會看它，存過就先跳確認；重新解析、核准、退回後清掉。
 * 失敗只略過，不影響主流程。
 */
function markDraft_(caseId, on) {
  try {
    const p = PropertiesService.getScriptProperties();
    if (on) p.setProperty('DRAFT_' + caseId, Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm'));
    else p.deleteProperty('DRAFT_' + caseId);
  } catch (e) {}
}

function draftSavedAt_(caseId) {
  try { return PropertiesService.getScriptProperties().getProperty('DRAFT_' + caseId) || ''; }
  catch (e) { return ''; }
}

// ============================================================
// Setup.gs
// ============================================================

/**
 * 初始安裝 — 整個專案只要跑一次 setup()
 * 會建立 Drive 資料夾結構與佇列試算表。定時工作需另外明確執行 installIntakeTrigger()。
 */

function setup() {
  const log = [];

  // 1. 建立資料夾
  const root = getOrCreateFolder_(DriveApp.getRootFolder(), CONFIG.ROOT_FOLDER_NAME);
  setProp_('ROOT_FOLDER_ID', root.getId());
  log.push('根資料夾：' + root.getName());

  Object.keys(CONFIG.FOLDERS).forEach(function (key) {
    const f = getOrCreateFolder_(root, CONFIG.FOLDERS[key]);
    setProp_('FOLDER_' + key, f.getId());
    log.push('  ' + f.getName());
  });

  // 2. 建立佇列試算表
  let sheetId = prop_('SHEET_ID', false);
  let ss;
  if (sheetId) {
    try { ss = SpreadsheetApp.openById(sheetId); } catch (e) { sheetId = ''; }
  }
  if (!sheetId) {
    ss = SpreadsheetApp.create(CONFIG.SHEET_NAME);
    DriveApp.getFileById(ss.getId()).moveTo(root);
    setProp_('SHEET_ID', ss.getId());
  }
  const sh = ss.getSheets()[0];
  sh.setName('佇列');
  if (sh.getLastRow() === 0) {
    sh.appendRow(COLUMNS);
    sh.getRange(1, 1, 1, COLUMNS.length)
      .setFontWeight('bold')
      .setBackground('#1a73e8')
      .setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.setColumnWidth(COLUMNS.indexOf('主旨') + 1, 300);
    sh.setColumnWidth(COLUMNS.indexOf('公告內文') + 1, 400);
  }
  log.push('佇列試算表：' + ss.getUrl());

  // 建置與啟用排程分開，設定或驗證環境時不會意外啟動正式工作。
  log.push('未變更任何觸發器。確認測試完成後，另行執行 installIntakeTrigger() 才會啟用掃描。');

  // 4. 檢查必要金鑰
  const missing = [];
  if (!prop_('ANTHROPIC_API_KEY', false)) missing.push('ANTHROPIC_API_KEY');
  if (CONFIG.AUTO_PUBLISH_ON_APPROVE) {
    if (!prop_('RPAGE_USER', false)) missing.push('RPAGE_USER');
    if (!prop_('RPAGE_PASS', false)) missing.push('RPAGE_PASS');
  }
  if (missing.length) {
    log.push('');
    log.push('⚠ 尚未設定的指令碼屬性：' + missing.join('、'));
    log.push('  到「專案設定 → 指令碼屬性」補上後才能正常運作。');
  }

  const msg = log.join('\n');
  Logger.log(msg);
  return msg;
}

/** 正式啟用定時掃描的獨立入口；只保留一個本系統的觸發器。 */
function installIntakeTrigger() {
  requireReviewer_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pollInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('pollInbox').timeBased().everyMinutes(10).create();
  return '已安裝每 10 分鐘掃描；可用 pauseAll() 停用。';
}

function getOrCreateFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function folder_(key) {
  return DriveApp.getFolderById(prop_('FOLDER_' + key, true));
}

/**
 * 佇列工作表：同一次執行只開一次（原本每讀寫一次就開一次試算表，核准一則要開十幾次）。
 * 第一次開時順便補上新版本加的欄位標題（例如 v9 的「歸檔分類」「公文本體ID」）。
 */
let SHEET_CACHE_ = null;
function sheet_() {
  if (SHEET_CACHE_) return SHEET_CACHE_;
  const sh = SpreadsheetApp.openById(prop_('SHEET_ID', true)).getSheetByName('佇列');
  ensureColumns_(sh);
  SHEET_CACHE_ = sh;
  return sh;
}

function ensureColumns_(sh) {
  // 每次執行第一次開工作表都檢查（只讀一列標題，很快）；不用專案層級的記號，換試算表也不會漏補
  try {
    const max = sh.getMaxColumns();
    if (max < COLUMNS.length) sh.insertColumnsAfter(max, COLUMNS.length - max);
    const head = sh.getRange(1, 1, 1, COLUMNS.length).getValues()[0];
    COLUMNS.forEach(function (k, i) { if (!head[i]) sh.getRange(1, i + 1).setValue(k); });
  } catch (e) {
    console.warn('補欄位失敗：' + e.message);
  }
}

/** 停用所有觸發器（維護或除錯時用） */
function pauseAll() {
  requireReviewer_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pollInbox') ScriptApp.deleteTrigger(t);
  });
  return '已停用本系統掃描。明確執行 installIntakeTrigger() 才會恢復。';
}

// ============================================================
// Intake.gs
// ============================================================

/**
 * 投遞與案件管理
 *
 * 三種放法（放進「00_待處理」）：
 *   1. 子資料夾：一個公文和它的附件放同一個資料夾，名稱隨意，整個資料夾 = 一個案件。
 *   2. 編號散檔：檔名開頭寫「1-1、1-2…」「2-0、2-1、2-2…」，前面數字相同的是同一個公文，
 *      系統自己建資料夾把它們放在一起。號碼最小的（1-1、2-0）當公文本體，其餘照號碼當附件。
 *   3. 其他單檔：各自一個沒有附件的案件。
 * 解析完會把資料夾、公文、附件都改名成「主題_西元年月日」（見 renameCaseFiles_）。
 *
 * 子資料夾和編號散檔會等最後一個檔案放進來滿 INTAKE_SETTLE_MINUTES 分鐘才收，
 * 避免檔案還在上傳就被拆成兩個案件；空資料夾先不收。
 *
 * 判定公文本體的順序：編號最小的檔 > 檔名含「公文」「函」「來文」> 第一個 PDF > 第一個檔案。
 */

const DOC_HINTS = ['公文', '來文', '函', '令', '開會通知'];

/**
 * 定時觸發的進入點
 *
 * 不整段占用 ScriptLock：收件要呼叫 AI，一跑好幾分鐘，會讓審核台的核准、退回與公告助手的
 * 領取一直拿不到鎖。改用 INTAKE_RUNNING 記號防止兩輪同時跑，ScriptLock 只在設記號時用一下。
 * 開始處理新案件前看時間，超過 INTAKE_BUDGET_MS 就留到下一輪，避免碰到 Apps Script 6 分鐘上限。
 */
const INTAKE_BUDGET_MS = 4 * 60 * 1000;

function pollInbox() {
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  const running = Number(props.getProperty('INTAKE_RUNNING') || 0);
  if (running && Date.now() - running < 7 * 60 * 1000) { lock.releaseLock(); return; }   // 上一輪還在跑
  props.setProperty('INTAKE_RUNNING', String(Date.now()));
  lock.releaseLock();

  const t0 = Date.now();
  try {
    sweepStaleParsing_();
    const cases = collectInbox_(folder_('INBOX'), new Date());
    for (let i = 0; i < cases.length; i++) {
      if (Date.now() - t0 > INTAKE_BUDGET_MS) break;      // 剩下的留在 00_待處理，下一輪再收
      try {
        intakeOne_(cases[i]);
      } catch (e) {
        console.error('收件失敗：' + e.message);
      }
    }
    try { checkWaiting_(); } catch (e) { console.warn('待發布提醒失敗：' + e.message); }
    try { backfillArchive_(5, t0 + INTAKE_BUDGET_MS); } catch (e) { console.warn('補歸檔資料夾失敗：' + e.message); }
  } finally {
    props.deleteProperty('INTAKE_RUNNING');
  }
}

/**
 * 「解析中」記號：PARSING_<caseId> = 開始時間。正常結束會清掉；
 * 留著超過 15 分鐘代表那次執行被中斷（例如 6 分鐘上限），案件改成「錯誤」並通知，才能重新解析。
 */
const PARSING_STALE_MS = 15 * 60 * 1000;

function markParsing_(caseId, on) {
  try {
    const p = PropertiesService.getScriptProperties();
    if (on) p.setProperty('PARSING_' + caseId, String(Date.now()));
    else p.deleteProperty('PARSING_' + caseId);
  } catch (e) {}
}

/** 卡在「新收件」或「解析中」超過 15 分鐘（執行被中斷） */
function isStaleParsing_(c) {
  if (c['狀態'] !== CONFIG.STATUS.PARSING && c['狀態'] !== CONFIG.STATUS.NEW) return false;
  let started = 0;
  try { started = Number(PropertiesService.getScriptProperties().getProperty('PARSING_' + c.caseId) || 0); } catch (e) {}
  if (!started) started = new Date(c['建立時間']).getTime() || 0;   // 舊案件沒有記號，用建立時間
  return Date.now() - started > PARSING_STALE_MS;
}

function sweepStaleParsing_() {
  listCases_([CONFIG.STATUS.NEW, CONFIG.STATUS.PARSING]).filter(isStaleParsing_).forEach(function (c) {
    updateCase_(c.caseId, { '狀態': CONFIG.STATUS.ERROR, '備註': '解析逾時中斷，請在審核台按「重新解析」' });
    markParsing_(c.caseId, false);
    try { notifyError_(c.caseId, '解析逾時中斷'); } catch (e) {}
  });
}

/**
 * 「1-1 公文.pdf」「2-0.pdf」「３－２_報名表.docx」→ { group, seq, rest }；不是編號檔回 null。
 * 前後兩段都只認 1–2 位數，「115-1學期」「113-05」這類學年編號不會被當成分組。
 * rest = 去掉編號後的原檔名（「1-2.pdf」→「.pdf」）。
 */
function numberedName_(name) {
  const s = String(name).replace(/[０-９]/g, function (ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  });
  const m = s.match(/^\s*(\d{1,2})\s*[-－–—_]\s*(\d{1,2})(?!\d)[\s_\-－–—、]*/);
  if (!m) return null;
  return { group: Number(m[1]), seq: Number(m[2]), rest: String(name).slice(m[0].length) };
}

/** 檔案或資料夾最後一次被放入／修改的時間（毫秒） */
function touched_(item) {
  const t = [];
  try { t.push(item.getDateCreated().getTime()); } catch (e) {}
  try { t.push(item.getLastUpdated().getTime()); } catch (e) {}
  return t.length ? Math.max.apply(null, t) : 0;
}

/** 把 00_待處理 的內容整理成這一輪要收的案件；還在上傳的先留到下一輪 */
function collectInbox_(inbox, now) {
  const settleMs = (CONFIG.INTAKE_SETTLE_MINUTES || 0) * 60000;
  const fresh = function (item) { return now.getTime() - touched_(item) < settleMs; };
  const cases = [];

  // 子資料夾 = 一個案件
  const folders = inbox.getFolders();
  while (folders.hasNext()) {
    const fd = folders.next();
    const inside = [];
    const it = fd.getFiles();
    while (it.hasNext()) inside.push(it.next());
    if (!inside.length) continue;                         // 空資料夾：可能還在上傳
    if (inside.some(fresh)) continue;                     // 剛放進新檔，下一輪再收
    cases.push({ type: 'folder', item: fd });
  }

  // 散檔：編號的依前面數字分組，其餘各自一案
  const groups = {};
  const singles = [];
  const files = inbox.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    const n = CONFIG.GROUP_NUMBERED_FILES ? numberedName_(f.getName()) : null;
    if (n) (groups[n.group] = groups[n.group] || []).push({ file: f, n: n });
    else singles.push(f);
  }

  const keys = Object.keys(groups).map(Number).sort(function (a, b) { return a - b; });
  const batchFresh = keys.some(function (k) {
    return groups[k].some(function (g) { return fresh(g.file); });
  });
  if (!batchFresh) {                                      // 同一批全部放完才一起收
    keys.forEach(function (k) {
      const items = groups[k].sort(function (a, b) { return a.n.seq - b.n.seq; });
      cases.push({ type: 'group', group: k, items: items.map(function (g) { return g.file; }) });
    });
  }

  singles.forEach(function (f) { cases.push({ type: 'file', item: f }); });
  return cases;
}

function intakeOne_(c) {
  const working = folder_('WORKING');
  const caseId = 'C' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss')
               + '-' + Math.floor(Math.random() * 900 + 100);

  let caseFolder;
  const moved = [];   // 寫不進佇列時要搬回 00_待處理 的檔案
  if (c.type === 'folder') {
    caseFolder = c.item;
    caseFolder.moveTo(working);
  } else if (c.type === 'group') {
    // 編號散檔：自己建資料夾放在一起；先用公文本體的原檔名命名，解析後改成「主題_日期」
    const first = numberedName_(c.items[0].getName());
    const label = first ? first.rest.replace(/\.[^.]+$/, '').trim() : '';
    caseFolder = working.createFolder(label || ('第' + c.group + '號公文'));
    c.items.forEach(function (f) { f.moveTo(caseFolder); moved.push(f); });
  } else {
    caseFolder = working.createFolder(c.item.getName().replace(/\.[^.]+$/, ''));
    c.item.moveTo(caseFolder);
    moved.push(c.item);
  }

  // 建立案件列；寫不進去就把檔案搬回 00_待處理，下一輪重收，不會留下沒有案件的資料夾
  const row = {};
  COLUMNS.forEach(function (k) { row[k] = ''; });
  row.caseId = caseId;
  row['建立時間'] = new Date();
  row['狀態'] = CONFIG.STATUS.NEW;
  row['資料夾ID'] = caseFolder.getId();
  try {
    appendCase_(row);
  } catch (e) {
    const inbox = folder_('INBOX');
    try {
      if (c.type === 'folder') caseFolder.moveTo(inbox);
      else { moved.forEach(function (f) { f.moveTo(inbox); }); caseFolder.setTrashed(true); }
    } catch (e2) {}
    throw e;
  }

  // 立刻解析
  processCase_(caseId);
}

/** 掃出案件資料夾內的檔案，分出公文本體與附件 */
function inspectFolder_(folderId) {
  const folder = DriveApp.getFolderById(folderId);
  const all = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    // 轉檔暫存檔（_tmp_／_scan_／_odf_tmp_）：執行被中斷時會留在資料夾裡，不能當成附件上傳
    if (/^_(tmp|scan|odf_tmp)_/.test(f.getName())) {
      try { f.setTrashed(true); } catch (e) {}
      continue;
    }
    let desc = '';
    try { desc = f.getDescription() || ''; } catch (e) {}
    all.push({
      id: f.getId(),
      name: f.getName(),
      mime: f.getMimeType(),
      size: f.getSize(),
      url: f.getUrl(),
      desc: desc            // 系統產生的 ODF 副本會標 odf-of:<來源檔ID>
    });
  }
  if (!all.length) throw new Error('案件資料夾裡沒有任何檔案');

  // 找公文本體。已改名成「主題_日期_附件N_原檔名」的一定是附件，不列入候選，
  // 否則附件原檔名含「函」「令」時會被誤認成公文。
  const pool = all.filter(function (f) { return !ATT_RE.test(f.name); });
  const cand = pool.length ? pool : all;

  // 有編號（1-1、2-0…）的，號碼最小的就是公文本體
  const numbered = cand.filter(function (f) { return numberedName_(f.name); })
    .sort(function (a, b) { return cmpOrder_(attOrder_(a), attOrder_(b)); });
  let main = numbered[0];
  if (!main) main = cand.find(function (f) {
    return DOC_HINTS.some(function (h) { return f.name.indexOf(h) >= 0; });
  });
  if (!main) main = cand.find(function (f) { return f.mime === MimeType.PDF; });
  if (!main) main = cand[0];

  // 附件排序固定：已改名的照「附件N」，編號檔照號碼，其他照檔名；重新解析也不會打亂附件編號
  const attachments = all.filter(function (f) { return f.id !== main.id; })
    .sort(function (a, b) { return cmpOrder_(attOrder_(a), attOrder_(b)); });
  return { main: main, attachments: attachments, all: all };
}

/** 已改名附件「主題_日期_附件3_原檔名.pdf」或「主題_日期_附件3.pdf」 */
const ATT_RE = /_附件(\d+)(?:_|\.[A-Za-z0-9]{1,8}$|$)/;

function attOrder_(f) {
  const a = String(f.name).match(ATT_RE);
  if (a) return [0, Number(a[1]), 0, f.name];
  const n = numberedName_(f.name);
  if (n) return [1, n.group, n.seq, f.name];
  return [2, 0, 0, f.name];
}

function cmpOrder_(x, y) {
  for (let i = 0; i < x.length; i++) {
    if (x[i] < y[i]) return -1;
    if (x[i] > y[i]) return 1;
  }
  return 0;
}

// ---------- 佇列存取 ----------

function appendCase_(row) {
  const sh = sheet_();
  sh.appendRow(COLUMNS.map(function (k) { return row[k] === undefined ? '' : row[k]; }));
  ROW_INDEX_ = null;   // 有新列，下次重新建索引
}

/**
 * caseId → 列號。同一次執行只讀一次 A 欄；找不到再重讀一次（別的執行可能剛新增）。
 * 系統只在最後面新增列、不會刪除（刪除案件只標成 DELETED）；有人手動排序或刪列時，
 * getCase_／updateCase_ 會發現那一列不是這個案件，重建索引再找。
 */
let ROW_INDEX_ = null;
function findRow_(caseId) {
  const build = function () {
    const sh = sheet_();
    const n = Math.max(sh.getLastRow() - 1, 1);
    const ids = sh.getRange(2, 1, n, 1).getValues();
    ROW_INDEX_ = {};
    for (let i = 0; i < ids.length; i++) if (ids[i][0]) ROW_INDEX_[ids[i][0]] = i + 2;
  };
  if (!ROW_INDEX_) build();
  if (!(caseId in ROW_INDEX_)) build();
  return caseId in ROW_INDEX_ ? ROW_INDEX_[caseId] : -1;
}

function getCase_(caseId) {
  const sh = sheet_();
  let r = findRow_(caseId);
  if (r < 0) throw new Error('找不到案件 ' + caseId);
  let vals = sh.getRange(r, 1, 1, COLUMNS.length).getValues()[0];
  if (String(vals[0]) !== String(caseId)) {            // 有人手動排序或刪列：列號變了，重建索引再讀
    ROW_INDEX_ = null;
    r = findRow_(caseId);
    if (r < 0) throw new Error('找不到案件 ' + caseId);
    vals = sh.getRange(r, 1, 1, COLUMNS.length).getValues()[0];
  }
  const obj = {};
  COLUMNS.forEach(function (k, i) { obj[k] = vals[i]; });
  obj._row = r;
  return obj;
}

function updateCase_(caseId, patch) {
  const sh = sheet_();
  let r = findRow_(caseId);
  if (r < 0) throw new Error('找不到案件 ' + caseId);
  if (String(sh.getRange(r, 1).getValue()) !== String(caseId)) {   // 寫之前確認這列還是這個案件
    ROW_INDEX_ = null;
    r = findRow_(caseId);
    if (r < 0) throw new Error('找不到案件 ' + caseId);
  }
  Object.keys(patch).forEach(function (k) {
    const i = COLUMNS.indexOf(k);
    if (i >= 0) sh.getRange(r, i + 1).setValue(patch[k]);
  });
}

function listCases_(statuses) {
  const sh = sheet_();
  if (sh.getLastRow() < 2) return [];
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, COLUMNS.length).getValues();
  return vals.map(function (v) {
    const o = {};
    COLUMNS.forEach(function (k, i) { o[k] = v[i]; });
    return o;
  }).filter(function (o) {
    return !statuses || statuses.indexOf(o['狀態']) >= 0;
  }).reverse();
}

/** 把案件資料夾搬到指定狀態的資料夾 */
function moveCaseFolder_(folderId, targetKey) {
  DriveApp.getFolderById(folderId).moveTo(folder_(targetKey));
}

// ============================================================
// ClaudeAI.gs
// ============================================================

/**
 * Claude 公文解析
 *
 * PDF 與圖片直接餵給模型（公文常是掃描檔，需要讀版面與用印）；
 * .odt/.doc/.docx 先透過 Drive 轉成 Google 文件取文字再送。
 *
 * 結構化輸出：把 JSON Schema 放進一個 tool 的 input_schema，再用 tool_choice
 * 強制呼叫它，模型就一定回傳符合 schema 的物件，不用解析自由文字。
 */

/** 回傳結構（JSON Schema），直接當 tool 的 input_schema 用。 */
function docSchema_() {
  const S = { type: 'string' };
  return {
    type: 'object',
    properties: {
      發文機關: S,
      發文字號: S,
      發文日期: { type: 'string', description: '一律轉成西元 yyyy-MM-dd；民國年請加 1911' },
      密等: { type: 'string', enum: ['普通', '密', '機密', '極機密', '限閱', '未標示'] },
      速別: S,
      主旨: { type: 'string', description: '照抄公文主旨欄全文' },
      說明摘要: { type: 'string', description: '把說明欄壓成 100 字內重點' },
      辦理期限: { type: 'string', description: '西元 yyyy-MM-dd，沒有期限給空字串' },
      適合公開: { type: 'boolean', description: '是否適合張貼在對外開放的學校網站' },
      不適合公開原因: S,
      建議分類: { type: 'string', enum: CONFIG.CATEGORIES },
      歸檔資料夾: { type: 'string', enum: CONFIG.ARCHIVE_FOLDERS.concat([CONFIG.UNFILED]),
                    description: '這份公文歸到學校哪個資料夾，都不像就填「未分類」' },
      適用對象: { type: 'string', enum: ['國中部', '國小部', '全校', '家長', '教師'] },
      公告標題: { type: 'string', description: '25 字內，不要加【】前綴，系統會自己加' },
      公告內文: { type: 'string', description: '家長與學生看得懂的白話說明，HTML 片段' },
      重點條列: { type: 'array', items: S },
      偵測到的個資: {
        type: 'array',
        description: '文件中出現的個人資料，照實列出類型與出現位置',
        items: {
          type: 'object',
          properties: {
            類型: { type: 'string', description: '如 身分證字號、姓名、電話、地址、帳號、弱勢身分' },
            摘要: { type: 'string', description: '不要完整複製號碼，描述即可' }
          },
          required: ['類型', '摘要']
        }
      }
    },
    required: [
      '發文機關', '發文字號', '發文日期', '密等', '主旨', '說明摘要',
      '適合公開', '建議分類', '適用對象', '公告標題', '公告內文', '重點條列', '偵測到的個資', '歸檔資料夾'
    ]
  };
}

function buildPrompt_(attachmentNames) {
  return [
    '你是' + CONFIG.SCHOOL_NAME + '的行政承辦人，負責把收到的公文改寫成學校網站公告。',
    '',
    '任務：讀完這份公文，抽出結構化資訊，並寫出一則可以直接貼上校網的公告。',
    '',
    '規則：',
    '1. 主旨照抄原文，不要改寫。說明摘要與公告內文才用自己的話。',
    '2. 公告內文寫給家長和學生看，不要用公文腔。不要出現「奉核」「請查照」「鈞長」這類詞。',
    '   用 <p> 分段，需要條列時用 <ul><li>。不要加 <html><body>，只要內容片段。',
    '3. 公告標題要具體。「關於辦理研習一案」不行，要寫出是什麼研習、什麼時候。',
    '4. 日期一律轉西元。公文上的「114年10月3日」是西元 2025-10-03。',
    '5. 密等欄位照公文上的標示填。沒有標示就填「未標示」。',
    '6. 適合公開＝false 的情況：密等非普通、內容涉及個別學生或教職員、僅供內部參考、',
    '   人事或考績相關、投標或採購底價、以及任何洩漏個資的內容。',
    '7. 偵測到的個資要誠實列出。描述即可，不要把身分證號或電話完整複製進來。',
    '8. 適用對象依公文內容判斷，分不出來就填「全校」。',
    '9. 公告內文是 HTML，必須符合無障礙網頁 AA 等級（WCAG 2.1 AA）：',
    '   - 只能用這些標記：<p> <br> <ul> <ol> <li> <strong> <em> <h3> <h4> <a href="https://...">。',
    '     不要用 style、class、表格、圖片、<font>、<b>、<i>、<h1>、<h2>。',
    '   - 需要小標題用 <h3>，再下一層才用 <h4>，不可跳級（網站已用 <h2> 當公告標題）。',
    '   - 條列一律用 <ul> 或 <ol>，不要用「‧」「-」、全形空白或連續 <br> 排版。',
    '   - 不要只靠顏色、粗體或位置傳達訊息（不可寫「紅字」「下方附件」「右側」），提到附件時直接寫出附件名稱。',
    '   - 網址要做成 <a href> 連結，連結文字要看得出目的地（例如「研習報名系統」），不可寫「點此」「按這裡」。',
    '   - 日期時間寫完整，例如「2026年11月5日（星期四）下午2時」；縮寫第一次出現要寫全名。',
    '10. 歸檔資料夾：從清單挑一個最符合這份公文主題的學校資料夾（例如資訊安全選「06.資安」、',
    '    無人機研習選「46.無人機」、經費核銷選「26.核銷」），都不像就填「未分類」。',
    '',
    attachmentNames.length
      ? '這份公文另有附件：' + attachmentNames.join('、') + '。公告內文可以提到附件，但不要編造附件內容。'
      : '這份公文沒有附件。'
  ].join('\n');
}

/** 主解析流程 */
function processCase_(caseId) {
  markParsing_(caseId, true);
  try {
    updateCase_(caseId, { '狀態': CONFIG.STATUS.PARSING });
    processCaseInner_(caseId);
  } catch (e) {
    // 沒預料到的錯誤（日期格式、Drive 或試算表暫時失敗…）轉成「錯誤」並通知，不會卡在「解析中」。
    // 只有還沒寫完結果（仍是新收件／解析中）才改；結果已寫入就不要蓋掉。
    try {
      const st = getCase_(caseId)['狀態'];
      if (st === CONFIG.STATUS.PARSING || st === CONFIG.STATUS.NEW) {
        updateCase_(caseId, { '狀態': CONFIG.STATUS.ERROR, '備註': '處理失敗：' + e.message });
        try { notifyError_(caseId, e.message); } catch (e3) {}
      } else {
        console.warn('案件 ' + caseId + ' 已寫入結果，後續步驟失敗：' + e.message);
      }
    } catch (e2) {}
  } finally {
    markParsing_(caseId, false);
  }
}

function processCaseInner_(caseId) {
  let c, info;
  try {
    c = getCase_(caseId);
    info = inspectFolder_(c['資料夾ID']);
  } catch (e) {
    updateCase_(caseId, { '狀態': CONFIG.STATUS.ERROR, '備註': e.message });
    try { notifyError_(caseId, e.message); } catch (e2) {}
    return;
  }

  let parsed;
  try {
    parsed = parseDocument_(info.main, info.attachments.map(function (a) { return a.name; }));
  } catch (e) {
    updateCase_(caseId, { '狀態': CONFIG.STATUS.ERROR, '備註': 'AI 解析失敗：' + e.message });
    try { notifyError_(caseId, e.message); } catch (e2) {}
    return;
  }

  // 風險檢核
  const risk = assessRisk_(parsed);

  // 個資掃描：附件內容與公文本體（這些檔案會原樣上傳校網）
  try {
    mergeRisk_(risk, scanFiles_(info));
  } catch (e) {
    mergeRisk_(risk, { level: '黃', notes: ['附件未掃描：個資掃描失敗（' + e.message + '），請逐一打開確認'] });
  }

  // ODF 規範：Word/Excel/PPT 沒有對應的 ODF 檔就自動轉一份（失敗只提醒，不中斷）
  if (CONFIG.AUTO_ODF) {
    try {
      ensureOdf_(c['資料夾ID'], info).forEach(function (n) { risk.reasons.push(n); });
    } catch (e) {
      risk.reasons.push('附件：自動產生 ODF 版本失敗（' + e.message + '），請手動補上傳');
    }
  }

  // 檔名整理：主題_西元年月日（失敗不影響流程）
  if (CONFIG.RENAME_FILES) {
    try { renameCaseFiles_(c['資料夾ID'], info, parsed); }
    catch (e) { console.warn('改檔名失敗：' + e.message); }
  }

  // 公告起迄：辦理期限格式看不懂或已過期，迄日改成合理值並提醒，不再出現「起迄日期不正確」
  const period = postPeriod_(parsed['辦理期限'], new Date());
  if (period.note) mergeRisk_(risk, { level: '黃', notes: [period.note] });

  const prefix = CONFIG.SCOPE_PREFIX[parsed['適用對象']] || '';
  const status = risk.level === '紅' || !parsed['適合公開']
    ? CONFIG.STATUS.BLOCKED
    : CONFIG.STATUS.REVIEW;

  updateCase_(caseId, {
    '狀態': status,
    '發文機關': parsed['發文機關'],
    '發文字號': parsed['發文字號'],
    '發文日期': parsed['發文日期'],
    '密等': parsed['密等'],
    '速別': parsed['速別'] || '',
    '主旨': parsed['主旨'],
    '辦理期限': period.deadline,
    '建議分類': parsed['建議分類'],
    '公告標題': prefix + parsed['公告標題'],
    '公告內文': buildBody_(parsed),
    '適用對象': parsed['適用對象'],
    '公告起日': period.start,
    '公告迄日': period.end,
    '風險等級': risk.level,
    '風險說明': joinNotes_(risk.reasons),
    '附件清單': JSON.stringify(info.attachments),
    // 歸檔資料夾：審核人手動選過的不蓋掉；AI 選的（含舊案件補的）用這次讀完整份公文的結果
    '歸檔分類': archiveManual_(caseId) || archiveOf_(parsed['歸檔資料夾']),
    '公文本體ID': info.main.id
  });
  markDraft_(caseId, false);   // 內容已換成 AI 新版，舊草稿記號作廢

  // 結果已經寫好：搬資料夾、寄通知失敗（例如郵件額度用完）都不影響案件狀態
  try { moveCaseFolder_(c['資料夾ID'], status === CONFIG.STATUS.BLOCKED ? 'REJECTED' : 'REVIEW'); }
  catch (e) { console.warn('搬資料夾失敗：' + e.message); }
  if (CONFIG.NOTIFY_NEW_CASE) {
    try { notifyReviewer_(caseId, status, risk); }
    catch (e) { console.warn('通知失敗：' + e.message); }
  }
}

/**
 * 把案件資料夾、公文本體與附件改名為「主題_西元年月日」
 *   公文：  主題_20260302.pdf
 *   附件：  主題_20260302_附件1_原檔名.docx
 *   資料夾：主題_20260302
 * 主題取公告標題（去掉【全校】等前綴），日期取發文日期，沒有就用今天。
 * 重跑解析時會先剝掉舊的前綴，不會疊成「主題_日期_附件1_主題_日期_附件1_…」。
 * 同時更新 info 裡的 name，讓後續寫進「附件清單」的是新檔名。
 */
function renameCaseFiles_(folderId, info, parsed) {
  const base = fileBase_(parsed);
  if (!base) return;

  const extOf = function (name) {
    const m = String(name).match(/\.([A-Za-z0-9]{1,8})$/);
    return m ? '.' + m[1].toLowerCase() : '';
  };
  // 原檔名：剝掉舊的「主題_日期_附件N_」和開頭的「1-2」編號
  const origOf = function (name) {
    let n = String(name).replace(/^.+_附件\d+(?:_|(?=\.[A-Za-z0-9]{1,8}$)|$)/, '');
    const num = numberedName_(n);
    if (num) n = num.rest;
    return n.trim();
  };

  const mainName = base + extOf(info.main.name);
  if (info.main.name !== mainName) {
    DriveApp.getFileById(info.main.id).setName(mainName);
    info.main.name = mainName;
  }

  info.attachments.forEach(function (a, i) {
    const orig = origOf(a.name);
    const onlyExt = !orig || /^\.[A-Za-z0-9]{1,8}$/.test(orig);   // 原本只有編號，例如「1-2.pdf」
    const newName = base + '_附件' + (i + 1) + (onlyExt ? extOf(a.name) : '_' + orig);
    if (a.name !== newName) {
      DriveApp.getFileById(a.id).setName(newName);
      a.name = newName;
    }
  });

  try { DriveApp.getFolderById(folderId).setName(base); } catch (e) {}
}

/**
 * ODF 規範：.doc/.docx → .odt、.xls/.xlsx → .ods、.ppt/.pptx → .odp
 * 已有同名 ODF 檔就跳過。轉檔走 Drive：先複製成 Google 格式，再匯出 ODF，最後刪掉暫存檔。
 * 新檔加進 info（放在來源檔後面），回傳需要提醒的文字。
 */
const ODF_RULES = {
  doc:  { g: 'application/vnd.google-apps.document',     mime: 'application/vnd.oasis.opendocument.text',            ext: 'odt' },
  docx: { g: 'application/vnd.google-apps.document',     mime: 'application/vnd.oasis.opendocument.text',            ext: 'odt' },
  xls:  { g: 'application/vnd.google-apps.spreadsheet',  mime: 'application/x-vnd.oasis.opendocument.spreadsheet',   ext: 'ods' },
  xlsx: { g: 'application/vnd.google-apps.spreadsheet',  mime: 'application/x-vnd.oasis.opendocument.spreadsheet',   ext: 'ods' },
  ppt:  { g: 'application/vnd.google-apps.presentation', mime: 'application/vnd.oasis.opendocument.presentation',     ext: 'odp' },
  pptx: { g: 'application/vnd.google-apps.presentation', mime: 'application/vnd.oasis.opendocument.presentation',     ext: 'odp' }
};

function splitName_(name) {
  const n = String(name).replace(/^.+_附件\d+(?:_|(?=\.[A-Za-z0-9]{1,8}$)|$)/, '');
  const m = n.match(/^(.*)\.([A-Za-z0-9]+)$/);
  return m ? { base: m[1], ext: m[2].toLowerCase() } : { base: n, ext: '' };
}

function ensureOdf_(folderId, info) {
  const notes = [];
  const folder = DriveApp.getFolderById(folderId);
  const files = [info.main].concat(info.attachments);
  // 系統產生的 ODF 描述標 odf-of:<來源檔ID>:<來源內容指紋>
  const tagOf = function (f) {
    const m = String(f.desc || '').match(/^odf-of:([^:]+)(?::(\w+))?/);
    return m ? { src: m[1], sig: m[2] || '' } : null;
  };
  const drop = function (f) {
    try { DriveApp.getFileById(f.id).setTrashed(true); } catch (e) {}
    [files, info.attachments, info.all || []].forEach(function (list) {
      const i = list.indexOf(f);
      if (i >= 0) list.splice(i, 1);
    });
  };
  const sources = {};
  files.forEach(function (f) { if (!tagOf(f)) sources[f.id] = true; });

  // 來源已經不在（被刪掉或換成新上傳的檔）的 ODF 副本：內容是舊的，移除，避免上傳過期資料
  files.slice().forEach(function (f) {
    const tg = tagOf(f);
    if (tg && !sources[tg.src]) { drop(f); notes.push('附件：已移除過期的 ODF 副本 ' + f.name); }
  });

  files.slice().forEach(function (f) {
    if (tagOf(f)) return;
    const p = splitName_(f.name);
    const rule = ODF_RULES[p.ext];
    if (!rule) return;
    const copy = files.filter(function (x) { const tg = tagOf(x); return tg && tg.src === f.id; })[0];
    const sig = srcSig_(f);
    if (copy) {
      const tg = tagOf(copy);
      if (!sig || !tg.sig || tg.sig === sig) return;   // 來源內容沒變
      drop(copy);                                       // 來源改過（例如刪掉名冊）→ 重新產生
    } else {
      // 使用者自己附的同名 ODF（沒有系統標記）
      const own = files.some(function (x) {
        if (x === f || tagOf(x)) return false;
        const q = splitName_(x.name);
        return q.base === p.base && q.ext === rule.ext;
      });
      if (own) return;
    }
    try {
      const blob = convertToOdf_(f.id, rule).setName(p.base + '.' + rule.ext);
      const nf = folder.createFile(blob);
      const tag = 'odf-of:' + f.id + (sig ? ':' + sig : '');
      try { nf.setDescription(tag); } catch (e) {}
      const rec = { id: nf.getId(), name: nf.getName(), mime: rule.mime, size: nf.getSize(), url: nf.getUrl(), desc: tag };
      const at = info.attachments.indexOf(f);
      info.attachments.splice(at < 0 ? 0 : at + 1, 0, rec);   // 公文本體的 ODF 排在附件第一個
      if (info.all) info.all.push(rec);
      files.push(rec);
      notes.push('附件：已自動產生 ' + rec.name + '（ODF 規範），請確認版面');
    } catch (e) {
      notes.push('附件：' + f.name + ' 轉 ODF 失敗（' + e.message + '），請手動補上傳 .' + rule.ext);
    }
  });
  return notes;
}

/** 來源檔內容指紋（MD5 前 6 位元組），用來判斷 ODF 副本是不是舊的；讀不到回 '' */
function srcSig_(f) {
  try {
    const d = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, DriveApp.getFileById(f.id).getBlob().getBytes());
    return d.slice(0, 6).map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
  } catch (e) { return ''; }
}

function convertToOdf_(fileId, rule) {
  const token = ScriptApp.getOAuthToken();
  const api = 'https://www.googleapis.com/drive/v3/files/';
  const r1 = UrlFetchApp.fetch(api + fileId + '/copy?supportsAllDrives=true', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ name: '_odf_tmp_' + fileId, mimeType: rule.g }),
    muteHttpExceptions: true
  });
  if (r1.getResponseCode() >= 300) throw new Error('轉成 Google 格式失敗 ' + r1.getResponseCode());
  const tmpId = JSON.parse(r1.getContentText()).id;
  try {
    const r2 = UrlFetchApp.fetch(api + tmpId + '/export?mimeType=' + encodeURIComponent(rule.mime), {
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
    });
    if (r2.getResponseCode() >= 300) throw new Error('匯出 ODF 失敗 ' + r2.getResponseCode());
    return r2.getBlob();
  } finally {
    try { DriveApp.getFileById(tmpId).setTrashed(true); } catch (e) {}
  }
}

/** 「主題_西元年月日」字串；主題去掉不能當檔名的字元並截長 */
function fileBase_(parsed) {
  let topic = String(parsed['公告標題'] || parsed['主旨'] || '').trim();
  topic = topic.replace(/^(【[^】]*】\s*)+/, '');          // 去掉【全校】等前綴
  // 檔名禁用字元換成全形，「2/6截止」→「2／6截止」，不會變成「2 6截止」
  const FW = { '\\': '＼', '/': '／', ':': '：', '*': '＊', '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜' };
  topic = topic.replace(/[\\\/:*?"<>|]/g, function (ch) { return FW[ch]; })
               .replace(/[\r\n\t]/g, ' ')
               .replace(/\s+/g, ' ').trim();
  if (topic.length > CONFIG.RENAME_MAX_LEN) topic = topic.slice(0, CONFIG.RENAME_MAX_LEN);
  if (!topic) return '';

  let d = null;
  const raw = String(parsed['發文日期'] || '');
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!d || isNaN(d.getTime())) d = new Date();
  const ymd = Utilities.formatDate(d, 'Asia/Taipei', 'yyyyMMdd');

  return topic + '_' + ymd;
}

/** 把模型輸出組成最終 HTML 內文 */
function buildBody_(p) {
  const parts = [sanitizeBody_(p['公告內文'])];
  if (p['重點條列'] && p['重點條列'].length) {
    parts.push('<ul>' + p['重點條列'].map(function (x) {
      return '<li>' + escapeHtml_(x) + '</li>';
    }).join('') + '</ul>');
  }
  // 不加 style：顏色與字級交給網站版型，避免對比不足（AA 1.4.3）
  parts.push('<p>資料來源：' + escapeHtml_(p['發文機關']) + ' ' + escapeHtml_(p['發文字號']) + '</p>');
  return parts.join('\n');
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"]/g, function (m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
  });
}

/**
 * 內文清理（安全＋無障礙 AA）
 *   - 只留 p br ul ol li strong em h3 h4 與 http(s) 連結；其他屬性一律拿掉（含 style、onclick）
 *   - b→strong、i→em（語意標記）；h1/h2→h3、h5/h6→h4（網站公告標題已是 h2，內文從 h3 起）
 *   - 不允許的標記只拿掉標記、保留文字（以前是變成看得到的「<table>」字樣）
 *   - script/style/iframe 等連內容一起移除；空段落、多餘空行、全形空白縮排清掉
 *   - 第一個小標題若是 h4 會升成 h3，避免標題跳級
 */
function sanitizeBody_(html) {
  const ALLOWED = { p: 1, br: 1, ul: 1, ol: 1, li: 1, strong: 1, em: 1, h3: 1, h4: 1, a: 1 };
  const RENAME = { b: 'strong', i: 'em', h1: 'h3', h2: 'h3', h5: 'h4', h6: 'h4' };
  let s = String(html || '')
    .replace(/<(script|style|iframe|object|embed|noscript|template|svg|math|textarea|select)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const linkStack = [];
  s = s.split(/(<[^>]*>)/g).map(function (part, i) {
    if (!(i % 2)) return part.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const m = part.match(/^<\s*(\/?)\s*([a-z][a-z0-9]*)\b([^>]*)>$/i);
    if (!m) return '';
    const close = !!m[1];
    const tag = RENAME[m[2].toLowerCase()] || m[2].toLowerCase();
    if (!ALLOWED[tag]) return '';
    if (tag === 'br') return close ? '' : '<br>';
    if (tag === 'a') {
      if (close) return linkStack.pop() ? '</a>' : '';
      const h = m[3].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i) || [];
      const href = String(h[1] || h[2] || h[3] || '').trim();
      const ok = /^https?:\/\/[^\s"'<>]+$/i.test(href);
      linkStack.push(ok);
      return ok ? '<a href="' + href.replace(/&(?!amp;)/g, '&amp;') + '">' : '';
    }
    return '<' + (close ? '/' : '') + tag + '>';
  }).join('');

  s = s
    .replace(/<p>(?:\s|&nbsp;|　|<br>)*<\/p>/g, '')                 // 空段落
    .replace(/(<p>|<li>|<h3>|<h4>)(?:\s|&nbsp;|　)+/g, '$1')          // 全形空白縮排
    .replace(/(?:<br>\s*){3,}/g, '<br><br>');                          // 連續空行

  // 標題不可跳級：第一個 h3 出現前的 h4 一律升成 h3
  const firstH3 = s.indexOf('<h3>');
  s = s.replace(/<h4>([\s\S]*?)<\/h4>/g, function (all, inner, off) {
    return (firstH3 < 0 || off < firstH3) ? '<h3>' + inner + '</h3>' : all;
  });
  return s.trim();
}

/** 無障礙 AA 檢查：清理後仍需要人看的地方，回傳提醒文字（不影響紅綠燈等級） */
function a11yIssues_(html) {
  const out = [];
  const s = String(html || '');
  const vague = /^(點此|點這裡|點我|按此|按這裡|這裡|此處|請點選|請點此|連結|更多|詳見|click here|here|more|link)$/i;
  (s.match(/<a href="[^"]*">[\s\S]*?<\/a>/g) || []).forEach(function (a) {
    const text = a.replace(/<[^>]+>/g, '').trim();
    if (!text || vague.test(text)) out.push('無障礙：連結文字「' + (text || '空白') + '」看不出目的地，請改成描述性文字');
    else if (/^https?:\/\//i.test(text)) out.push('無障礙：連結文字直接是網址，建議改成說明目的地的文字');
  });
  const plain = s.replace(/<[^>]+>/g, ' ');
  const sensory = plain.match(/(下方附件|如下方|詳下方|右側|左側|右方|左方|紅色字|紅字|藍色字|以紅色|標紅)/);
  if (sensory) out.push('無障礙：內文用位置或顏色指示（「' + sensory[1] + '」），請改成直接寫出附件名稱或內容');
  if (plain.trim().length > 200 && !/<p>|<li>/.test(s)) out.push('無障礙：內文沒有分段，請用段落或條列');
  return out;
}

/** 依檔案型態決定怎麼送進模型 */
function parseDocument_(mainFile, attachmentNames) {
  const prompt = buildPrompt_(attachmentNames || []);
  const parts = [{ text: prompt }];

  const readable = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
  if (readable.indexOf(mainFile.mime) >= 0) {
    const blob = DriveApp.getFileById(mainFile.id).getBlob();
    if (blob.getBytes().length > CONFIG.MAX_INLINE_MB * 1024 * 1024) {
      throw new Error('公文檔案超過 ' + CONFIG.MAX_INLINE_MB + 'MB，請先壓縮或拆檔');
    }
    parts.push({
      inline_data: {
        mime_type: mainFile.mime,
        data: Utilities.base64Encode(blob.getBytes())
      }
    });
  } else {
    const text = extractText_(mainFile);
    if (!text || text.length < 20) throw new Error('無法從 ' + mainFile.name + ' 取出文字');
    parts.push({ text: '\n\n===== 公文全文 =====\n' + text });
  }

  return callClaude_(parts, docSchema_());
}

/** odt / doc / docx 等走 Drive 轉檔取文字 */
function extractText_(file) {
  const token = ScriptApp.getOAuthToken();
  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files/' + file.id + '/copy?supportsAllDrives=true',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({
        name: '_tmp_' + file.name,
        mimeType: 'application/vnd.google-apps.document'
      }),
      muteHttpExceptions: true
    }
  );
  if (res.getResponseCode() >= 300) {
    throw new Error('轉檔失敗 (' + res.getResponseCode() + ')：' + res.getContentText().slice(0, 200));
  }
  const tmpId = JSON.parse(res.getContentText()).id;
  try {
    return DocumentApp.openById(tmpId).getBody().getText();
  } finally {
    try { DriveApp.getFileById(tmpId).setTrashed(true); } catch (e) {}
  }
}

/**
 * 呼叫 Claude Messages API，含重試。
 * parts 沿用原本的中性格式：{text} 或 {inline_data:{mime_type,data}}，這裡轉成 Claude 的區塊。
 */
function strictSchema_(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(strictSchema_);
  const out = {};
  Object.keys(node).forEach(function (key) { out[key] = strictSchema_(node[key]); });
  if (out.type === 'object') {
    out.additionalProperties = false;
    if (!out.required) out.required = [];
  }
  return out;
}

function callClaude_(parts, schema) {
  const content = parts.map(function (p) {
    if (p.text !== undefined) return { type: 'text', text: p.text };
    const mime = p.inline_data.mime_type;
    const src = { type: 'base64', media_type: mime, data: p.inline_data.data };
    return mime === 'application/pdf'
      ? { type: 'document', source: src }
      : { type: 'image', source: src };
  });

  const payload = {
    model: CONFIG.CLAUDE_MODEL,
    max_tokens: CONFIG.AI_MAX_TOKENS,
    // Sonnet 5.5 不接受取樣參數與強制 tool_choice；直接使用 JSON Schema 輸出。
    output_config: {
      effort: CONFIG.AI_EFFORT,
      format: { type: 'json_schema', schema: strictSchema_(schema) }
    },
    messages: [{ role: 'user', content: content }]
  };

  let lastErr = '';
  for (let i = 0; i <= CONFIG.AI_RETRY; i++) {
    const res = UrlFetchApp.fetch(CONFIG.ANTHROPIC_BASE + '/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': prop_('ANTHROPIC_API_KEY', true),
        'anthropic-version': CONFIG.ANTHROPIC_VERSION
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    const body = res.getContentText();

    if (code === 200) {
      const json = JSON.parse(body);
      if (json.stop_reason === 'max_tokens') {
        throw new Error('回應被截斷，請拆檔或調高 AI_MAX_TOKENS');
      }
      if (json.stop_reason === 'refusal') throw new Error('模型拒絕回應這份內容');
      const block = (json.content || []).filter(function (b) { return b.type === 'text'; })[0];
      if (!block) throw new Error('模型沒有回傳結構化結果');
      try { return JSON.parse(block.text); }
      catch (e) { throw new Error('模型回傳的不是合法 JSON'); }
    }

    lastErr = code + ' ' + body.slice(0, 300);
    if (code === 429 || code === 529 || code >= 500) {
      Utilities.sleep(2000 * (i + 1));   // 額度、過載或暫時性錯誤，退避重試
      continue;
    }
    break;   // 400/401/403 重試沒意義
  }
  throw new Error('Claude 呼叫失敗：' + lastErr);
}

/** 重新解析單一案件（審核時覺得草稿不好可以重跑） */
function reparse(caseId) {
  requireReviewer_();
  const c = getCase_(caseId);
  if ([CONFIG.STATUS.REVIEW, CONFIG.STATUS.BLOCKED, CONFIG.STATUS.ERROR].indexOf(c['狀態']) < 0) {
    throw new Error('此案件目前不能重新解析');
  }
  processCase_(caseId);
  return getCase_(caseId);
}

// ============================================================
// PrivacyCheck.gs
// ============================================================

/**
 * 密等判定與個資紅綠燈
 *
 * 紅燈：禁止公開，案件直接擋下，審核頁不給核准按鈕。
 * 黃燈：可以公開，但審核人必須逐項確認。
 * 綠燈：沒有偵測到風險。
 *
 * 掃描範圍：
 *   1. 公告標題與內文（AI 寫的、要貼上校網的文字）→ RED_PATTERNS／YELLOW_PATTERNS
 *   2. AI 在公文裡看到的個資 → 身分證、銀行帳號為紅，其餘黃（出生日期交給檔案掃描判斷）
 *   3. 附件與公文本體的實際內容（scanFiles_）→ 這些檔案會原樣上傳，真正出事的多半是附件裡的名冊
 *      掃不到的附件（圖片、簡報、壓縮檔…）亮黃燈，核准前一定要勾「已開啟檢查」
 *
 * 風險說明的前綴決定燈號，存草稿重算時會保留（noteLevel_）：
 *   原公文含X：…   X 是身分證、銀行帳號為紅，其餘黃（AI 註明已遮蔽的算黃）
 *   公文本體含個資：… 附件含個資：…   紅
 *   附件需確認：… 附件未掃描：… 期限：…   黃
 *   附件：…（ODF 提醒）  只提醒，不影響燈號
 */

const RED_PATTERNS = [
  { re: /[A-Z][12]\d{8}/,                       label: '身分證字號' },
  { re: /09\d{2}[-\s]?\d{3}[-\s]?\d{3}/,        label: '行動電話' },
  { re: /[\u4e00-\u9fa5]{2,}(路|街|大道)[\u4e00-\u9fa5\d]*\d+號/, label: '完整住址' },
  // 排除公文字號（第…號）裡的流水號，避免 10 位數字號被誤判成帳號
  // 10 碼 0 開頭（沒加分隔的市話、手機）不算帳號；手機另有上面一條
  { re: /(?<![第\d])(?!0\d{9}(?!\d))\d{10,16}(?![\d號])/, label: '疑似金融帳號' },
  { re: /民國\d{2,3}年\d{1,2}月\d{1,2}日生|\d{4}\/\d{1,2}\/\d{1,2}出生/, label: '出生年月日' }
];

/** 這些身分一旦跟姓名同時出現就是紅燈 */
const SENSITIVE_STATUS = [
  '低收入戶', '中低收入戶', '清寒', '特殊境遇', '急難救助',
  '身心障礙', '鑑輔會', '特教生', '資源班',
  '中輟', '中途輟學', '高關懷', '輔導個案', '認輔',
  '性平', '性騷擾', '性侵', '霸凌',
  '家暴', '保護個案', '高風險家庭', '脆弱家庭',
  '原住民身分', '新住民子女', '失親', '單親'
];

const YELLOW_PATTERNS = [
  { re: /7\d{2}\s*班?\s*\d{1,2}\s*號/,  label: '班級座號' },
  { re: /[\w.+-]+@[\w-]+\.[\w.]+/,      label: '電子郵件' },
  { re: /學號\s*[:：]?\s*\d{4,}/,        label: '學號' },
  // 市話多半是學校或機關的公務電話，不算個資；寫明是家長／住家電話才提醒
  { re: /(家長|住家|家用|宅電|住宅)[^\n]{0,12}?(\(0\d{1,2}\)\s?\d{3,4}[-\s]?\d{4}|0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4})/, label: '住家電話' }
];

/** 掃描前把 HTML 標籤拿掉（換成空白，前後文字不會黏成一串數字）、還原常見字元實體 */
function plainText_(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function assessRisk_(parsed) {
  const reasons = [];
  let level = '綠';

  // --- 密等 ---
  const sec = parsed['密等'] || '未標示';
  if (['密', '機密', '極機密', '限閱'].indexOf(sec) >= 0) {
    return { level: '紅', reasons: ['公文密等為「' + sec + '」，不得對外公開'] };
  }

  // --- 模型自己判斷不宜公開 ---
  if (parsed['適合公開'] === false) {
    return {
      level: '紅',
      reasons: ['研判不宜公開：' + (parsed['不適合公開原因'] || '未說明')]
    };
  }

  // --- 掃描要上網的文字 ---
  const raw = [
    parsed['公告標題'], parsed['公告內文'], parsed['主旨'], parsed['說明摘要'],
    (parsed['重點條列'] || []).join(' ')
  ].join('\n');
  // 原文（連標籤屬性裡的電話也掃得到）＋去掉標籤的純文字（「家長電話</b>：02-…」這類才對得上）
  const text = raw + '\n' + plainText_(raw);

  RED_PATTERNS.forEach(function (p) {
    if (p.re.test(text)) {
      level = '紅';
      reasons.push('公告內文含' + p.label);
    }
  });

  // 敏感身分 + 人名
  const hasName = /[\u4e00-\u9fa5]{1,2}[\u4e00-\u9fa5]{1,2}同學|[\u4e00-\u9fa5]{2,3}(君|先生|小姐|女士)/.test(text);
  SENSITIVE_STATUS.forEach(function (w) {
    if (text.indexOf(w) >= 0) {
      if (hasName) {
        level = '紅';
        reasons.push('同時出現「' + w + '」與個人姓名');
      } else if (level !== '紅') {
        level = '黃';
        reasons.push('提及「' + w + '」，確認沒有指向特定個人');
      }
    }
  });

  if (level !== '紅') {
    YELLOW_PATTERNS.forEach(function (p) {
      if (p.re.test(text)) {
        level = '黃';
        reasons.push('公告內文含' + p.label);
      }
    });
  }

  // --- 模型在原始公文裡看到的個資（公文本體也會上傳校網）---
  (parsed['偵測到的個資'] || []).forEach(function (x) {
    const note = '原公文含' + x['類型'] + '：' + x['摘要'] + '（確認未隨附件外流）';
    level = maxLevel_(level, noteLevel_(note));
    reasons.push(note);
  });

  if (!reasons.length) reasons.push('未偵測到明顯風險');
  // 無障礙提醒附在後面，只提醒、不改變紅綠燈
  return { level: level, reasons: reasons.concat(a11yIssues_(sanitizeBody_(parsed['公告內文']))) };
}

/** 給審核頁即時重算用：使用者改完內文後重新檢查 */
function recheck(caseId, title, body) {
  requireReviewer_();
  const c = getCase_(caseId);
  const risk = assessRisk_({
    '密等': c['密等'],
    '適合公開': c['狀態'] !== CONFIG.STATUS.BLOCKED,
    '公告標題': title,
    '公告內文': body,
    '主旨': c['主旨'],
    '說明摘要': '',
    '重點條列': [],
    '偵測到的個資': []
  });

  // 原公文、附件的個資與期限提醒只有解析時算得出來，改內文不會讓它消失；
  // 這些檔案會上傳校網，所以存檔重算時要保留，並照各自的等級算燈號（ODF 提醒不影響燈號）。
  const kept = String(c['風險說明'] || '').split('；').filter(isDocNote_);
  if (kept.length) mergeRisk_(risk, { level: kept.map(noteLevel_).reduce(maxLevel_, '綠'), notes: kept });

  updateCase_(caseId, { '風險等級': risk.level, '風險說明': joinNotes_(risk.reasons) });
  return risk;
}

// ---------- 燈號工具 ----------

const LEVEL_RANK_ = { '綠': 0, '黃': 1, '紅': 2 };
function maxLevel_(a, b) { return (LEVEL_RANK_[b] || 0) > (LEVEL_RANK_[a] || 0) ? b : a; }

/** 解析時產生、存草稿要保留的提醒 */
const DOC_NOTE_RE_ = /^(原公文含|公文本體含個資：|附件含個資：|附件需確認：|附件未掃描：|期限：|附件：)/;
function isDocNote_(r) { return DOC_NOTE_RE_.test(String(r)); }

function noteLevel_(r) {
  r = String(r);
  if (/^原公文含/.test(r)) {
    // AI 在公文裡看到的個資（公文本體會公開上傳）：身分證、銀行帳號 → 紅
    if (/遮蔽|隱碼|\*|＊|○/.test(r)) return '黃';                    // AI 註明已遮蔽（A12****789）
    const type = r.split('：')[0];
    if (/身分證|居留證/.test(type)) return '紅';
    if (/帳號|帳戶|存摺|金融/.test(type) && /銀行|郵局|存摺|匯款|金融|帳戶|受款|收款|轉帳|撥款|入帳/.test(r)) return '紅';
    return '黃';   // 出生日期交給檔案掃描判斷：AI 常把「某年某月出生者」這類資格說明也列進來
  }
  if (/^(公文本體含個資|附件含個資)：/.test(r)) return '紅';
  if (/^(附件需確認|附件未掃描|期限)：/.test(r)) return '黃';
  return '綠';   // 「附件：」ODF 提醒、無障礙提醒
}

/** 提醒用「；」串起來存，單則提醒裡的「；」改成「，」，存草稿拆開時才不會斷成兩半 */
function cleanNote_(s) { return String(s).replace(/；/g, '，'); }
function joinNotes_(arr) { return arr.map(cleanNote_).join('；'); }

/** 把一組提醒併進 risk：拿掉「未偵測到明顯風險」，燈號取較嚴重的 */
function mergeRisk_(risk, extra) {
  if (!extra || !extra.notes || !extra.notes.length) return risk;
  risk.reasons = risk.reasons.filter(function (r) { return r !== '未偵測到明顯風險'; }).concat(extra.notes);
  risk.level = maxLevel_(risk.level, extra.level || '綠');
  return risk;
}

/** 檔案內容掃描出來的紅燈（可由審核人確認後解除，例如附件裡是範例資料） */
function isFileRedNote_(n) { return /^(公文本體含個資|附件含個資)：/.test(String(n)); }

/** 被擋下的原因「只有」檔案掃描的紅燈：密等、不宜公開、內文個資、原公文身分證等其他紅燈都不能這樣解除 */
function canOverrideFileRed_(c) {
  if (c['狀態'] !== CONFIG.STATUS.BLOCKED) return false;
  const notes = String(c['風險說明'] || '').split('；');
  if (!notes.some(isFileRedNote_)) return false;
  return !notes.some(function (n) {
    if (isFileRedNote_(n)) return false;
    return /^(公文密等|研判不宜公開|同時出現|公告內文含(身分證字號|行動電話|市話號碼|完整住址|疑似金融帳號|出生年月日))/.test(n) ||
           noteLevel_(n) === '紅';
  });
}

/** 核准前一定要人工打開檢查的情況：有附件沒掃到，或掃到疑似名冊 */
function needsFileCheck_(c) {
  return /(^|；)(附件未掃描|附件需確認)：/.test(String(c['風險說明'] || ''));
}

/** 強制送出前要勾「已開啟檢查」：上面兩種，加上檔案掃到個資的紅燈 */
function forceNeedsFileCheck_(c) {
  return needsFileCheck_(c) || String(c['風險說明'] || '').split('；').some(isFileRedNote_);
}

// ---------- 公告期間 ----------

/** 辦理期限轉西元 yyyy-MM-dd；接受 2026-11-30、2026/11/30、115年11月30日、民國115.11.30；看不懂回 '' */
function normDate_(s) {
  const t = String(s || '').trim().replace(/[０-９]/g, function (ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  });
  let r = t.match(/^(\d{4})\s*[-\/.年]\s*(\d{1,2})\s*[-\/.月]\s*(\d{1,2})/);
  let y;
  if (r) y = Number(r[1]);
  else {
    r = t.match(/^(?:民國)?\s*(\d{2,3})\s*[-\/.年]\s*(\d{1,2})\s*[-\/.月]\s*(\d{1,2})/);
    if (!r) return '';
    y = Number(r[1]) + 1911;
  }
  const m = Number(r[2]), d = Number(r[3]);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return '';
  return y + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
}

/**
 * 公告起迄：起日一律今天。
 *   有期限且還沒過 → 迄日 = 期限
 *   沒有期限 → 迄日 = 今天 + DEFAULT_POST_DAYS
 *   期限已過 → 迄日 = 今天 + EXPIRED_POST_DAYS，並提醒（黃燈）
 *   期限看不懂 → 迄日 = 今天 + DEFAULT_POST_DAYS，並提醒（黃燈）
 */
function postPeriod_(raw, now) {
  const day = function (plus) {
    return Utilities.formatDate(new Date(now.getTime() + plus * 86400000), 'Asia/Taipei', 'yyyy-MM-dd');
  };
  const today = day(0);
  const deadline = normDate_(raw);
  const rawText = String(raw || '').trim();
  if (rawText && !deadline) {
    return { start: today, end: day(CONFIG.DEFAULT_POST_DAYS), deadline: '',
             note: '期限：辦理期限「' + rawText.slice(0, 30) + '」看不懂，迄日先訂 ' + day(CONFIG.DEFAULT_POST_DAYS) + '，請確認' };
  }
  if (!deadline) return { start: today, end: day(CONFIG.DEFAULT_POST_DAYS), deadline: '', note: '' };
  if (deadline < today) {
    const end = day(CONFIG.EXPIRED_POST_DAYS);
    return { start: today, end: end, deadline: deadline,
             note: '期限：辦理期限 ' + deadline + ' 已過，迄日先改為 ' + end + '，請確認是否還要公告' };
  }
  return { start: today, end: deadline, deadline: deadline, note: '' };
}

// ---------- 檔案內容個資掃描 ----------

const SCAN_MAX_BYTES_ = 10 * 1024 * 1024;

/** 身分證、新式居留證號檢查碼（A123456789 是常見範例，排除） */
function twIdValid_(id) {
  id = String(id).toUpperCase();
  if (!/^[A-Z][1289]\d{8}$/.test(id) || id === 'A123456789') return false;
  const code = 'ABCDEFGHJKLMNPQRSTUVXYWZIO'.indexOf(id[0]) + 10;
  let sum = Math.floor(code / 10) + (code % 10) * 9;
  for (let i = 1; i <= 8; i++) sum += Number(id[i]) * (9 - i);
  sum += Number(id[9]);
  return sum % 10 === 0;
}

/** 範例、填寫說明（「例：99.01.01」「範例：王小明」）不算真的個資 */
const EXAMPLE_RE_ = /例|範本|樣本|說明|填寫|格式|如：|如:|王小明|王大明|○○|ＯＯ/;

/** 找出符合的字串，前後幾個字是範例或說明的略過 */
function realMatches_(t, re) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(t))) {
    const around = t.slice(Math.max(0, m.index - 12), m.index + m[0].length + 8);
    if (!EXAMPLE_RE_.test(around)) out.push(m[0]);
  }
  return out;
}

/** 純文字掃描 → { red:[], yellow:[] }，每項是「身分證字號 3 筆」這類描述 */
function scanText_(text) {
  const t = String(text || '');
  const red = [], yellow = [];
  const ids = {};
  realMatches_(t.toUpperCase(), /[A-Z][1289]\d{8}/g).forEach(function (x) { if (twIdValid_(x)) ids[x] = 1; });
  const nId = Object.keys(ids).length;
  if (nId) red.push('身分證字號 ' + nId + ' 筆');
  const births = realMatches_(t, /(出生(?:日期|年月日)?|生日)\s*[:：]\s*\d{2,4}\s*[\/.\-年]\s*\d{1,2}\s*[\/.\-月]\s*\d{1,2}|民國\d{2,3}年\d{1,2}月\d{1,2}日生/g);
  if (births.length) red.push('出生日期 ' + births.length + ' 筆');
  const mobiles = {};
  (t.match(/09\d{2}[-\s]?\d{3}[-\s]?\d{3}/g) || []).forEach(function (x) { mobiles[x.replace(/\D/g, '')] = 1; });
  const nMob = Object.keys(mobiles).length;
  if (nMob >= 3) yellow.push('行動電話 ' + nMob + ' 筆');
  return { red: red, yellow: yellow };
}

/** 試算表：除了全文掃描，再看欄位標題（出生日期、帳號、姓名＋電話／地址的名冊） */
function scanRows_(rows) {
  // 範例列、填寫說明列（含「例」「說明」或範例姓名）不算資料
  rows = rows.filter(function (r) { return !EXAMPLE_RE_.test(r.join(' ')); });
  const flat = rows.map(function (r) { return r.join(' '); }).join('\n');
  const res = scanText_(flat);
  const HEAD = /姓名|身分證|居留證|出生|生日|帳號|存摺|帳戶|電話|手機|地址|住址/;
  let h = -1, best = 0;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const n = rows[i].filter(function (x) { return HEAD.test(String(x)); }).length;
    if (n > best) { best = n; h = i; }
  }
  if (h < 0) return res;
  // 有姓名欄的表：姓名空白的列（空白報名表）不算
  const nameCols = [];
  rows[h].forEach(function (head, j) { if (/姓名/.test(String(head))) nameCols.push(j); });
  const data = rows.slice(h + 1).filter(function (r) {
    return !nameCols.length || nameCols.some(function (j) { return /[\u4e00-\u9fa5]{2,4}/.test(String(r[j] || '')); });
  });
  const count = function (re, valRe) {
    let n = 0;
    rows[h].forEach(function (head, j) {
      if (!re.test(String(head))) return;
      data.forEach(function (r) { if (valRe.test(String(r[j] || '').trim())) n++; });
    });
    return n;
  };
  const nBirth = count(/出生|生日/, /\d{1,4}\s*[\/.\-年]\s*\d{1,2}/);
  if (nBirth && !res.red.some(function (x) { return /出生/.test(x); })) res.red.push('出生日期 ' + nBirth + ' 筆');
  const nAcct = count(/帳號|存摺|帳戶/, /\d{8,}/);
  if (nAcct) res.red.push('帳號 ' + nAcct + ' 筆');
  const nName = count(/姓名/, /[一-龥]{2,4}/);
  const nContact = count(/電話|手機|地址|住址/, /\d{6,}|[一-龥]{2,}(路|街|里|號)/);
  if (nName >= 3 && nContact >= 3) res.yellow.push('疑似名冊（姓名 ' + nName + ' 筆＋聯絡資料）');
  return res;
}

function scanSheet_(file) {
  const token = ScriptApp.getOAuthToken();
  const res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + file.id + '/copy?supportsAllDrives=true', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ name: '_scan_' + file.name, mimeType: 'application/vnd.google-apps.spreadsheet' }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) throw new Error('轉檔失敗 ' + res.getResponseCode());
  const tmpId = JSON.parse(res.getContentText()).id;
  try {
    let out = { red: [], yellow: [] };
    SpreadsheetApp.openById(tmpId).getSheets().forEach(function (sh) {
      const rows = sh.getDataRange().getDisplayValues().slice(0, 3000);
      const r = scanRows_(rows);
      out.red = out.red.concat(r.red);
      out.yellow = out.yellow.concat(r.yellow);
    });
    return out;
  } finally {
    try { DriveApp.getFileById(tmpId).setTrashed(true); } catch (e) {}
  }
}

/** 'text'：轉 Google 文件取文字；'sheet'：轉試算表；null：掃不到（圖片、簡報、壓縮檔…） */
function scanKind_(f) {
  const ext = (String(f.name).match(/\.([A-Za-z0-9]{1,8})$/) || ['', ''])[1].toLowerCase();
  if (['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt'].indexOf(ext) >= 0) return 'text';
  if (['xls', 'xlsx', 'ods', 'csv'].indexOf(ext) >= 0) return 'sheet';
  if (f.mime === 'application/vnd.google-apps.document') return 'text';
  if (f.mime === 'application/vnd.google-apps.spreadsheet') return 'sheet';
  return null;
}

/**
 * 掃描公文本體與附件的實際內容 → { level, notes }
 *   紅：身分證／居留證號（含檢查碼）、出生日期、帳號欄有資料
 *   黃：行動電話 3 筆以上、疑似名冊；掃不到或轉檔失敗的附件
 * 公文本體只回報紅燈等級的發現（承辦人電話、Email 本來就會出現在公文上，已有 AI 提醒）。
 * 系統自動產生的 ODF 副本（描述標 odf-of:）內容跟來源一樣，略過。
 */
const SCAN_BUDGET_MS_ = 150 * 1000;   // 一個案件掃描最多花多久，剩下的標成未掃描（避免碰到 6 分鐘上限）

function scanFiles_(info, deadline) {
  deadline = deadline || Date.now() + SCAN_BUDGET_MS_;
  const out = { level: '綠', notes: [] };
  const add = function (lv, note) { out.notes.push(note); out.level = maxLevel_(out.level, lv); };
  const targets = [{ f: info.main, main: true }].concat((info.attachments || []).map(function (a) {
    return { f: a, main: false };
  }));
  targets.forEach(function (t) {
    if (/^odf-of:/.test(t.f.desc || '')) return;   // 系統產生的 ODF：來源變了會重新產生（ensureOdf_）
    const unscanned = function (why) { if (!t.main) add('黃', '附件未掃描：' + t.f.name + '（' + why + '，請打開確認）'); };
    const kind = scanKind_(t.f);
    if (!kind) return unscanned('圖片、簡報或壓縮檔');
    if ((t.f.size || 0) > SCAN_MAX_BYTES_) return unscanned('檔案太大');
    if (Date.now() > deadline) return unscanned('檔案多，時間不夠掃完');
    let r;
    try {
      if (kind === 'sheet') r = scanSheet_(t.f);
      else {
        const text = extractText_(t.f);
        // 轉出來幾乎沒有文字：多半是掃描圖檔，讀不到內容，不能當成沒有個資
        if (String(text || '').replace(/\s/g, '').length < 30 && (t.f.size || 0) > 2000) return unscanned('讀不到文字，可能是掃描圖檔');
        r = scanText_(text);
      }
    } catch (e) { return unscanned('轉檔失敗'); }
    if (r.red.length) add('紅', (t.main ? '公文本體含個資：' : '附件含個資：') + t.f.name + ' 有' + r.red.join('、'));
    else if (!t.main && r.yellow.length) add('黃', '附件需確認：' + t.f.name + ' 有' + r.yellow.join('、'));
  });
  return out;
}

// ============================================================
// WebApp.gs
// ============================================================

/**
 * 審核介面後端
 *
 * 部署：編輯器右上「部署 → 新增部署作業 → 網頁應用程式」
 *   執行身分：我
 *   存取對象：僅限自己 或 同網域使用者（不要選任何人）
 */

function doGet(e) {
  // 帶 api 參數的請求走 Bridge.gs，給瀏覽器腳本用
  if (e && e.parameter && e.parameter.api) return bridgeRoute_(e);

  return HtmlService.createTemplateFromFile('Review')
    .evaluate()
    .setTitle('公文自動公告 — 審核台')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');   // 不允許別的網站用 iframe 嵌入審核台
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** 待審核 + 已擋下 + 近期已發布 */
function requireReviewer_() {
  const active = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  const owner = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!active || !owner || active !== owner) throw new Error('請以專案擁有者帳號登入，沒有審核權限。');
  return active;
}

/**
 * 審核台清單：待處理、最近完成（RECENT_HOURS 小時內）、歷史公文（更早的，依歸檔資料夾分頁）、公告助手狀態。
 * 已刪除的不顯示。整張表只讀一次。
 */
function api_list() {
  requireReviewer_();
  const S = CONFIG.STATUS;
  const PENDING = [S.REVIEW, S.BLOCKED, S.NEW, S.PARSING, S.ERROR, S.APPROVED, S.SUBMITTING];
  const DONE = [S.PUBLISHED, S.REJECTED];
  const all = listCases_();
  const cut = Date.now() - CONFIG.RECENT_HOURS * 3600 * 1000;
  const done = all.filter(function (c) { return DONE.indexOf(c['狀態']) >= 0; });
  return {
    pending: slim_(all.filter(function (c) { return PENDING.indexOf(c['狀態']) >= 0; })),
    done: slim_(done.filter(function (c) { return doneAt_(c) >= cut; })),
    archive: slim_(done.filter(function (c) { return doneAt_(c) < cut; }).slice(0, 1000)),
    folders: CONFIG.ARCHIVE_FOLDERS.concat([CONFIG.UNFILED]),
    recentHours: CONFIG.RECENT_HOURS,
    helper: helperStatus_()
  };
}

/** 完成時間：已發布看發布時間，退回看審核時間，都沒有就用建立時間 */
function doneAt_(c) {
  const t = c['狀態'] === CONFIG.STATUS.PUBLISHED ? c['發布時間'] : c['審核時間'];
  const v = new Date(t || c['建立時間']).getTime();
  return isNaN(v) ? 0 : v;
}

function archiveOf_(v) {
  return CONFIG.ARCHIVE_FOLDERS.indexOf(v) >= 0 ? v : CONFIG.UNFILED;
}

function slim_(rows) {
  let props = {};
  try { props = PropertiesService.getScriptProperties().getProperties(); } catch (e) {}
  return rows.map(function (r) {
    return {
      caseId: r.caseId,
      status: r['狀態'],
      title: r['公告標題'] || r['主旨'] || '(未解析)',
      org: r['發文機關'],
      risk: r['風險等級'],
      category: r['建議分類'],
      created: r['建立時間'] ? Utilities.formatDate(new Date(r['建立時間']), 'Asia/Taipei', 'MM/dd HH:mm') : '',
      archive: archiveOf_(r['歸檔分類']),
      // 送出中超過 30 分鐘還沒確認上架 → 清單上提醒人工確認
      stale: r['狀態'] === CONFIG.STATUS.SUBMITTING &&
             Date.now() - Number(props['CLAIM_' + r.caseId] || 0) > SUBMIT_STALE_MS
    };
  });
}

const SUBMIT_STALE_MS = 30 * 60 * 1000;

function claimedAt_(caseId) {
  try {
    const t = Number(PropertiesService.getScriptProperties().getProperty('CLAIM_' + caseId) || 0);
    return t ? Utilities.formatDate(new Date(t), 'Asia/Taipei', 'MM/dd HH:mm') : '';
  } catch (e) { return ''; }
}

function api_detail(caseId) {
  requireReviewer_();
  const c = getCase_(caseId);
  // 審核台列出「實際會上傳校網的檔案」，公文本體排第一並標註，審核人才會一起檢查
  const files = publishFiles_(c);
  const mainFile = files.filter(function (f) { return f.isMain; })[0];
  const mainFileId = mainFile ? mainFile.id : '';
  const atts = files.map(function (f) {
    return f.isMain ? Object.assign({}, f, { name: '（公文本體）' + f.name }) : f;
  });

  return {
    caseId: c.caseId,
    status: c['狀態'],
    org: c['發文機關'],
    docNo: c['發文字號'],
    docDate: fmtDate_(c['發文日期']),     // 試算表會把日期字串轉成 Date，網頁端不接受 Date 回傳值
    security: c['密等'],
    subject: c['主旨'],
    deadline: fmtDate_(c['辦理期限']),
    category: c['建議分類'],
    title: c['公告標題'],
    body: sanitizeBody_(c['公告內文']),
    scope: c['適用對象'],
    startDate: fmtDate_(c['公告起日']),
    endDate: fmtDate_(c['公告迄日']),
    risk: c['風險等級'],
    riskNotes: String(c['風險說明'] || '').split('；').filter(String),
    attachments: atts,
    mainFileId: mainFileId,
    siteUrl: c['校網網址'],
    note: c['備註'],
    draftSavedAt: draftSavedAt_(caseId),   // 存過草稿的時間（MM/dd HH:mm），重新解析前要確認
    needsFileCheck: needsFileCheck_(c),     // 有附件沒掃到或疑似名冊：核准前要勾「已開啟檢查」
    canOverride: canOverrideFileRed_(c),    // 只因附件掃描被擋下：可寫原因解除紅燈
    claimedAt: claimedAt_(caseId),          // 公告助手領取（開始送出）的時間
    archive: archiveOf_(c['歸檔分類']),       // 歸檔資料夾（歷史公文分頁）
    folders: CONFIG.ARCHIVE_FOLDERS.concat([CONFIG.UNFILED]),
    canForce: isRedCase_(c),                // 紅燈：確認後可強制送出
    forceFileCheck: forceNeedsFileCheck_(c),// 強制送出前也要勾「已開啟檢查」
    secret: isSecret_(c),                   // 公文標示密等：強制送出要再輸入「確認公開」
    categories: CONFIG.CATEGORIES,
    scopes: Object.keys(CONFIG.SCOPE_PREFIX),
    blocked: c['狀態'] === CONFIG.STATUS.BLOCKED
  };
}

function fmtDate_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}

/** 只存草稿不發布 */
function validateDraft_(d) {
  if (!d || !String(d.title || '').trim() || !String(d.body || '').trim()) throw new Error('標題與內文不可空白。');
  if (CONFIG.CATEGORIES.indexOf(d.category) < 0 || !CONFIG.SCOPE_PREFIX[d.scope]) throw new Error('公告分類或適用對象不正確。');
  const validDate = function (s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
    const date = new Date(s + 'T00:00:00Z');
    return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === s;
  };
  if (!validDate(d.startDate) || !validDate(d.endDate)) throw new Error('公告起迄日期不正確。');
  if (d.startDate > d.endDate) throw new Error('公告迄日早於起日（常見原因是辦理期限已過），請把迄日改到起日之後，或退回這則。');
}

function api_save(caseId, d) {
  requireReviewer_();
  const c = getCase_(caseId);
  if ([CONFIG.STATUS.REVIEW, CONFIG.STATUS.BLOCKED].indexOf(c['狀態']) < 0) {
    throw new Error('只有待審核案件可以修改，請重新載入。');
  }
  validateDraft_(d);
  updateCase_(caseId, {
    '公告標題': d.title,
    '公告內文': sanitizeBody_(d.body),
    '建議分類': d.category,
    '適用對象': d.scope,
    '公告起日': d.startDate,
    '公告迄日': d.endDate
  });
  markDraft_(caseId, true);
  const risk = recheck(caseId, d.title, d.body);
  return { ok: true, risk: risk, savedAt: draftSavedAt_(caseId) };
}

/** 核准 → 依設定直接發布 */
function api_approve(caseId, d) {
  requireReviewer_();
  const c = getCase_(caseId);
  if (c['狀態'] === CONFIG.STATUS.PUBLISHED) return { ok: true, message: '此案件已發布。', url: c['校網網址'] };
  if (c['狀態'] === CONFIG.STATUS.APPROVED) return { ok: true, message: '此案件已核准，等待發布。' };
  if (c['狀態'] === CONFIG.STATUS.BLOCKED && CONFIG.BLOCK_ON_RED) {
    return { ok: false, message: canOverrideFileRed_(c)
      ? '這則因為附件掃描到疑似個資被擋下。打開附件確認：若是範例或可以公開，請按「確認附件可公開，解除紅燈」並寫下原因。'
      : '此案件因密等、不宜公開或公告內文含個資被擋下，無法核准。' };
  }
  if (c['狀態'] !== CONFIG.STATUS.REVIEW) return { ok: false, message: '只有待審核案件可以核准。' };
  if (needsFileCheck_(c) && !(d && d.filesChecked === true)) {
    return { ok: false, message: '有附件沒辦法自動掃描或疑似名冊，請先逐一打開檢查，再勾選「我已打開檢查附件」後核准。' };
  }

  api_save(caseId, d);
  const after = getCase_(caseId);
  if (after['風險等級'] === '紅' && CONFIG.BLOCK_ON_RED) {
    return { ok: false, message: '修改後仍偵測到紅燈風險：' + after['風險說明'] +
             '。確認可以公開的話，請用「確認風險，強制送出」。' };
  }

  updateCase_(caseId, {
    '狀態': CONFIG.STATUS.APPROVED,
    '審核人': Session.getActiveUser().getEmail(),
    '審核時間': new Date()
  });
  markDraft_(caseId, false);

  if (!CONFIG.AUTO_PUBLISH_ON_APPROVE) {
    return { ok: true, message: '已核准，等待發布。' };
  }

  try {
    const url = publishCase_(caseId);
    return { ok: true, message: '已發布到校網。', url: url };
  } catch (e) {
    updateCase_(caseId, { '備註': '發布失敗：' + e.message });
    return {
      ok: false,
      message: '已核准但發布失敗：' + e.message +
               '\n草稿已保留，修正後可在列表按「重試發布」。'
    };
  }
}

function api_retryPublish(caseId) {
  requireReviewer_();
  if (!CONFIG.AUTO_PUBLISH_ON_APPROVE) return { ok: false, message: '自動發布已停用，請由公告助手填表後人工送出。' };
  const c = getCase_(caseId);
  if (c['狀態'] === CONFIG.STATUS.PUBLISHED) return { ok: true, message: '此案件已發布。', url: c['校網網址'] };
  if (c['狀態'] !== CONFIG.STATUS.APPROVED) return { ok: false, message: '只有已核准案件可以發布。' };
  try {
    const url = publishCase_(caseId);
    return { ok: true, message: '已發布。', url: url };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

const REJECTABLE_ = ['REVIEW', 'BLOCKED', 'ERROR', 'PARSING', 'NEW', 'APPROVED'];

/**
 * 退回。跟公告助手的「領取」用同一把鎖、鎖內重讀狀態：
 * 不會發生「助手剛領走、這邊又退回」，送出中的案件也不能退回（公告可能已經上了校網）。
 */
function api_reject(caseId, note) {
  requireReviewer_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('系統忙碌中，請過幾秒再按一次。');
  let c;
  try {
    c = getCase_(caseId);
    if (c['狀態'] === CONFIG.STATUS.PUBLISHED) throw new Error('已發布案件不能退回。');
    if (c['狀態'] === CONFIG.STATUS.SUBMITTING) {
      throw new Error('公告助手正在送出這則，不能退回。請先到校網後台確認：已上架就用「已上架，貼網址」；' +
                      '後台沒有這則再用「後台沒有這則，改回待發布」，之後才能退回。');
    }
    // 只接受審核台會出現「退回」的狀態；已刪除、已退回的不能再退回（免得刪掉的案件又跑回來）
    if (REJECTABLE_.indexOf(c['狀態']) < 0) throw new Error('這則目前是「' + c['狀態'] + '」，不能退回，請重新整理。');
    updateCase_(caseId, {
      '狀態': CONFIG.STATUS.REJECTED,
      '審核人': Session.getActiveUser().getEmail(),
      '審核時間': new Date(),
      '備註': note || '審核退回'
    });
  } finally {
    lock.releaseLock();
  }
  markDraft_(caseId, false);
  try { moveCaseFolder_(c['資料夾ID'], 'REJECTED'); } catch (e) {}
  return { ok: true };
}

/**
 * 附件掃描紅燈的人工解除：審核人打開附件確認是範例或可以公開，寫下原因後改回待審。
 * 紅燈提醒改成「附件需確認：…（已人工解除紅燈：原因）」，核准時仍要勾「已開啟檢查」。
 * 重新解析會重新掃描，紅燈會再出現（需要再確認一次）。
 */
function api_overrideFileRed(caseId, reason) {
  requireReviewer_();
  reason = cleanNote_(String(reason || '').trim()).slice(0, 100);
  if (reason.length < 4) throw new Error('請寫下解除的原因（例如：附件裡是範例資料）。');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('系統忙碌中，請過幾秒再按一次。');
  let c;
  try {
    c = getCase_(caseId);
    if (!canOverrideFileRed_(c)) throw new Error('這則不是只因為附件掃描被擋下，不能在這裡解除。');
    const notes = String(c['風險說明']).split('；').map(function (n) {
      return isFileRedNote_(n)
        ? '附件需確認：' + n.replace(/^(公文本體含個資|附件含個資)：/, '') + '（已人工解除紅燈：' + reason + '）'
        : n;
    });
    updateCase_(caseId, {
      '狀態': CONFIG.STATUS.REVIEW,
      '風險等級': notes.map(noteLevel_).reduce(maxLevel_, '黃'),
      '風險說明': joinNotes_(notes),
      '備註': '人工解除附件紅燈：' + reason + '（' + Session.getActiveUser().getEmail() + ' ' +
              Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm') + '）'
    });
  } finally {
    lock.releaseLock();
  }
  try { moveCaseFolder_(c['資料夾ID'], 'REVIEW'); } catch (e) {}
  return api_detail(caseId);
}

/**
 * 審核台改歸檔資料夾（刪除的以外都可以改）。手動選的記在 ARCHMAN_<caseId>，
 * 之後重新解析、補歸檔都不會蓋掉。
 */
function api_setArchive(caseId, folder) {
  requireReviewer_();
  if (CONFIG.ARCHIVE_FOLDERS.indexOf(folder) < 0 && folder !== CONFIG.UNFILED) throw new Error('沒有這個歸檔資料夾：' + folder);
  const c = getCase_(caseId);
  if (c['狀態'] === CONFIG.STATUS.DELETED) throw new Error('這則已刪除，請重新整理。');
  PropertiesService.getScriptProperties().setProperty('ARCHMAN_' + caseId, folder);
  updateCase_(caseId, { '歸檔分類': folder });
  return { ok: true, archive: folder };
}

/** 審核人手動選的歸檔資料夾；沒選過回 '' */
function archiveManual_(caseId) {
  try { return PropertiesService.getScriptProperties().getProperty('ARCHMAN_' + caseId) || ''; } catch (e) { return ''; }
}

/**
 * 刪除整份公文：資料夾連同檔案丟到 Google 雲端硬碟垃圾桶（30 天內可以救回），
 * 佇列這一列標成 DELETED、審核台不再顯示（列本身保留做紀錄，列號也才不會位移）。
 * 送出中、解析中的不能刪；已發布的只刪系統這邊，校網上的公告要到後台自己刪。
 */
function api_deleteCase(caseId) {
  requireReviewer_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('系統忙碌中，請過幾秒再按一次。');
  let c;
  try {
    c = getCase_(caseId);
    const st = c['狀態'];
    if (st === CONFIG.STATUS.DELETED) return { ok: true, trashed: false };
    if (st === CONFIG.STATUS.SUBMITTING) {
      throw new Error('公告助手正在送出這則，不能刪除。請先到校網後台確認，用「已上架，貼網址」或「改回待發布」處理後再刪。');
    }
    if ((st === CONFIG.STATUS.PARSING || st === CONFIG.STATUS.NEW) && !isStaleParsing_(c)) {
      throw new Error('這則正在解析中，請等解析完再刪除。');
    }
    updateCase_(caseId, {
      '狀態': CONFIG.STATUS.DELETED,
      '備註': '已刪除（原狀態 ' + st + '；' + Session.getActiveUser().getEmail() + ' ' +
              Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm') + '）'
    });
  } finally {
    lock.releaseLock();
  }
  let trashed = false;
  try { DriveApp.getFolderById(c['資料夾ID']).setTrashed(true); trashed = true; } catch (e) {}
  markDraft_(caseId, false);
  try {
    const p = PropertiesService.getScriptProperties();
    p.deleteProperty('CLAIM_' + caseId);
    p.deleteProperty('PARSING_' + caseId);
    p.deleteProperty('ARCHMAN_' + caseId);
  } catch (e) {}
  return { ok: true, trashed: trashed };
}

/** 已退回的案件重新送審：回到待審（紅燈的回到已擋下），之前的「強制送出」確認作廢、要重新確認 */
function api_resubmit(caseId) {
  requireReviewer_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('系統忙碌中，請過幾秒再按一次。');
  let c, next;
  try {
    c = getCase_(caseId);
    if (c['狀態'] !== CONFIG.STATUS.REJECTED) throw new Error('只有已退回的案件可以重新送審。');
    const notes = String(c['風險說明'] || '').split('；').filter(function (n) { return n && !/^人工確認強制送出：/.test(n); });
    next = c['風險等級'] === '紅' ? CONFIG.STATUS.BLOCKED : CONFIG.STATUS.REVIEW;
    updateCase_(caseId, {
      '狀態': next,
      '風險說明': joinNotes_(notes.length ? notes : ['未偵測到明顯風險']),
      '備註': '重新送審 ' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm')
    });
  } finally {
    lock.releaseLock();
  }
  if (next === CONFIG.STATUS.REVIEW) { try { moveCaseFolder_(c['資料夾ID'], 'REVIEW'); } catch (e) {} }
  return api_detail(caseId);
}

/** 紅燈（已擋下，或修改後仍是紅燈的待審）案件 */
function isRedCase_(c) {
  return c['狀態'] === CONFIG.STATUS.BLOCKED || (c['狀態'] === CONFIG.STATUS.REVIEW && c['風險等級'] === '紅');
}
function isSecret_(c) { return ['密', '機密', '極機密', '限閱'].indexOf(String(c['密等'] || '')) >= 0; }
function isForced_(c) { return /(^|；)人工確認強制送出：/.test(String(c['風險說明'] || '')); }

/**
 * 紅燈強制送出：審核人看過風險、寫下原因後直接核准，公告助手照常自動發布。
 * 紅燈原因原樣保留在風險說明，另加一行「人工確認強制送出：原因（帳號 時間）」做紀錄。
 * 公文標示密等時，還要在確認框輸入「確認公開」。
 */
function api_forceApprove(caseId, d, reason, typed) {
  requireReviewer_();
  reason = cleanNote_(String(reason || '').trim()).slice(0, 100);
  if (reason.length < 4) throw new Error('請寫下確認可以公開的原因。');
  validateDraft_(d);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('系統忙碌中，請過幾秒再按一次。');
  let c;
  try {
    c = getCase_(caseId);
    if (!isRedCase_(c)) throw new Error('這則不是紅燈案件，請直接按「核准，送交發布」。');
    if (forceNeedsFileCheck_(c) && !(d && d.filesChecked === true)) {
      throw new Error('這則的附件或公文本體需要人工檢查，請先逐一打開，再勾選「我已打開檢查附件」。');
    }
    if (isSecret_(c) && String(typed || '').trim() !== '確認公開') {
      throw new Error('這份公文標示密等「' + c['密等'] + '」，要在確認框輸入「確認公開」才能強制送出。');
    }
    const who = Session.getActiveUser().getEmail();
    const when = Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm');
    const notes = String(c['風險說明'] || '').split('；').filter(function (n) { return n && !/^人工確認強制送出：/.test(n); })
      .concat(['人工確認強制送出：' + reason + '（' + who + ' ' + when + '）']);
    updateCase_(caseId, {
      '公告標題': d.title,
      '公告內文': sanitizeBody_(d.body),
      '建議分類': d.category,
      '適用對象': d.scope,
      '公告起日': d.startDate,
      '公告迄日': d.endDate,
      '狀態': CONFIG.STATUS.APPROVED,
      '風險等級': '紅',
      '風險說明': joinNotes_(notes),
      '審核人': who,
      '審核時間': new Date(),
      '備註': '紅燈強制送出：' + reason
    });
  } finally {
    lock.releaseLock();
  }
  markDraft_(caseId, false);
  try { moveCaseFolder_(c['資料夾ID'], 'REVIEW'); } catch (e) {}
  return { ok: true, message: '已強制核准，等待公告助手發布。' };
}

// ---------- 公告助手心跳與提醒 ----------

/**
 * 公告助手每一輪回報狀態：running（正常）／stuck（在跑但沒辦法送出，附原因）／off（沒勾自動）／
 * paused（出錯暫停，附原因）／login（後台登入過期）。審核台頂端看得到。
 * 變成 paused 或 login 就通知（Telegram，傳不出去改寄 email）：同一段狀態只通知一次；送不出去或還在 30 分鐘冷卻內，下一次回報再試。
 * 兩種提醒各自冷卻，不會因為剛寄過登入過期就漏掉暫停。stuck 不馬上寄，核准的公告等太久才由 checkWaiting_ 寄。
 */
function bridgeBeat_(p) {
  const props = PropertiesService.getScriptProperties();
  let prev = {};
  try { prev = JSON.parse(props.getProperty('HELPER_BEAT') || '{}'); } catch (e) {}
  const beat = { at: Date.now(), auto: p.auto === '1', state: String(p.state || '').slice(0, 20), msg: String(p.msg || '').slice(0, 200) };
  const alertable = beat.state === 'paused' || beat.state === 'login';
  beat.alerted = alertable && prev.state === beat.state && !!prev.alerted;
  if (alertable && !beat.alerted) {
    try {
      beat.alerted = alertOnce_('HELPER_ALERT_' + beat.state, 30,
        beat.state === 'login' ? '校網後台登入已過期，自動發布停住了' : '公告助手自動發布已暫停',
        beat.state === 'login' ? '請重新登入校網後台並回到公告模組頁，登入後會自動繼續。'
          : '原因：' + (beat.msg || '請到後台分頁看公告助手面板的訊息') + '\n排除後到後台分頁重新勾選「核准後自動發布」。');
    } catch (e) { beat.alerted = false; }
  }
  props.setProperty('HELPER_BEAT', JSON.stringify(beat));
  return { ok: true };
}

function helperStatus_() {
  let b = {};
  try { b = JSON.parse(PropertiesService.getScriptProperties().getProperty('HELPER_BEAT') || '{}'); } catch (e) {}
  if (!b.at) return { state: 'never' };
  return { state: b.state, auto: !!b.auto, msg: b.msg || '', ageMin: Math.round((Date.now() - b.at) / 60000),
           at: Utilities.formatDate(new Date(b.at), 'Asia/Taipei', 'MM/dd HH:mm') };
}

/** 送提醒（每種提醒在 minutes 分鐘內只送一次），走 notify_：Telegram，傳不出去改寄 email */
function alertOnce_(key, minutes, subject, text) {
  const props = PropertiesService.getScriptProperties();
  if (Date.now() - Number(props.getProperty(key) || 0) < minutes * 60 * 1000) return false;
  notify_(subject, text);
  props.setProperty(key, String(Date.now()));
  return true;
}

/**
 * 核准超過 1 小時還沒發布、公告助手又不在正常運作 → 通知（3 小時內不重複）。
 * 助手回報正常但超過 2 小時還沒送出，也一樣寄（可能卡在助手看不出來的地方）。
 */
function checkWaiting_() {
  const waits = listCases_([CONFIG.STATUS.APPROVED]).map(function (c) {
    return { c: c, ms: Date.now() - new Date(c['審核時間']).getTime() };
  }).filter(function (x) { return x.ms > 60 * 60 * 1000; });
  if (!waits.length) return false;
  const waiting = waits.map(function (x) { return x.c; });
  const longest = Math.max.apply(null, waits.map(function (x) { return x.ms; }));
  const h = helperStatus_();
  if (h.state === 'running' && h.auto && h.ageMin <= 15 && longest < 2 * 60 * 60 * 1000) return false;   // 助手正常在跑，只是還沒輪到
  const why = h.state === 'never' ? '公告助手還沒有回報過（請安裝 1.7 版，並開著校網後台分頁）'
    : h.ageMin > 15 ? '公告助手已經 ' + h.ageMin + ' 分鐘沒有回報（電腦關機、Chrome 關掉或後台分頁沒開）'
    : h.state === 'login' ? '校網後台登入已過期'
    : h.state === 'paused' ? '公告助手已暫停：' + (h.msg || '請看後台分頁的公告助手面板')
    : !h.auto ? '公告助手的「核准後自動發布」沒有勾選'
    : h.state === 'stuck' ? '公告助手在跑，但沒辦法送出：' + h.msg
    : '公告助手在跑，但這幾則超過 2 小時還沒送出，請到後台分頁看公告助手面板的訊息';
  return alertOnce_('WAIT_ALERT_AT', 180, '有 ' + waiting.length + ' 則核准超過 1 小時還沒發布',
    why + '\n' + waiting.slice(0, 10).map(function (c) { return '・' + (c['公告標題'] || c['主旨']); }).join('\n'));
}

// ---------- 舊案件補歸檔資料夾 ----------

function archiveSchema_() {
  return { type: 'object', properties: { 歸檔資料夾: { type: 'string', enum: CONFIG.ARCHIVE_FOLDERS.concat([CONFIG.UNFILED]) } },
           required: ['歸檔資料夾'] };
}

/**
 * 還沒有歸檔資料夾的舊案件，每輪用標題與主旨請 AI 補幾則（失敗就填「未分類」，不重試）。
 * deadline 之後不再開始下一則，免得整輪超過 Apps Script 6 分鐘上限。
 * 寫入前重讀一次：AI 還在判斷時審核人可能已經手動選了，選了就不蓋掉。
 */
function backfillArchive_(limit, deadline) {
  const todo = listCases_().filter(function (c) {
    return !c['歸檔分類'] && c['狀態'] !== CONFIG.STATUS.DELETED && c['狀態'] !== CONFIG.STATUS.NEW && c['狀態'] !== CONFIG.STATUS.PARSING;
  }).slice(0, limit || 5);
  let n = 0;
  for (let i = 0; i < todo.length; i++) {
    if (deadline && Date.now() > deadline - 90 * 1000) break;    // AI 呼叫加重試可能要一兩分鐘，留 90 秒
    const c = todo[i];
    let folder = CONFIG.UNFILED;
    const text = [c['公告標題'], c['主旨']].filter(Boolean).join('');
    if (text) {
      try {
        const r = callClaude_([{ text: [
          '這是' + CONFIG.SCHOOL_NAME + '收到的一則公文。請從資料夾清單挑最符合主題的一個，都不像就填「未分類」。',
          '公告標題：' + (c['公告標題'] || ''), '主旨：' + (c['主旨'] || ''), '發文機關：' + (c['發文機關'] || '')
        ].join('\n') }], archiveSchema_());
        folder = archiveOf_(r['歸檔資料夾']);
      } catch (e) {
        console.warn('補歸檔資料夾失敗 ' + c.caseId + '：' + e.message);
      }
    }
    const now = getCase_(c.caseId);
    if (now['歸檔分類'] || archiveManual_(c.caseId)) continue;   // 這段時間已經有人選了
    updateCase_(c.caseId, { '歸檔分類': folder });
    n++;
  }
  return n;
}

/** 送出中的案件：人工到校網確認已上架，貼網址標成已發布 */
function api_markPublished(caseId, url) {
  requireReviewer_();
  const c = getCase_(caseId);
  if (c['狀態'] !== CONFIG.STATUS.SUBMITTING && c['狀態'] !== CONFIG.STATUS.APPROVED) {
    throw new Error('只有待發布或送出中的案件可以標成已發布。');
  }
  const r = bridgeDone_(caseId, String(url || '').trim());
  try { PropertiesService.getScriptProperties().deleteProperty('CLAIM_' + caseId); } catch (e) {}
  return r;
}

/**
 * 送出中的案件：人工到後台確認「沒有這則」，改回待發布。
 * 自動發布開著的話，下一輪會重新送出；不想發了，改回待發布後再按退回。
 */
function api_unsubmit(caseId) {
  requireReviewer_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('系統忙碌中，請過幾秒再按一次。');
  try {
    const c = getCase_(caseId);
    if (c['狀態'] !== CONFIG.STATUS.SUBMITTING) throw new Error('這則不是送出中，請重新整理。');
    updateCase_(caseId, {
      '狀態': CONFIG.STATUS.APPROVED,
      '校網網址': '',
      '備註': '人工確認後台沒有這則，改回待發布 ' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm')
    });
  } finally {
    lock.releaseLock();
  }
  try { PropertiesService.getScriptProperties().deleteProperty('CLAIM_' + caseId); } catch (e) {}
  return { ok: true };
}

function api_reparse(caseId) {
  requireReviewer_();
  const c = getCase_(caseId);
  // 卡在「解析中」超過 15 分鐘（上次執行被中斷）也可以重新解析
  if ([CONFIG.STATUS.REVIEW, CONFIG.STATUS.BLOCKED, CONFIG.STATUS.ERROR].indexOf(c['狀態']) < 0 && !isStaleParsing_(c)) {
    throw new Error(c['狀態'] === CONFIG.STATUS.PARSING ? '正在解析中，請稍候再整理清單' : '此案件目前不能重新解析');
  }
  try { moveCaseFolder_(c['資料夾ID'], 'WORKING'); } catch (e) {}
  processCase_(caseId);
  return api_detail(caseId);
}

// ---------- 通知 ----------

function notifyReviewer_(caseId, status, risk) {
  const to = prop_('NOTIFY_EMAIL', false);
  if (!to) return;
  const c = getCase_(caseId);
  const webapp = ScriptApp.getService().getUrl();
  const flag = status === CONFIG.STATUS.BLOCKED ? '🔴 已擋下' : (risk.level === '黃' ? '🟡 待審核' : '🟢 待審核');

  MailApp.sendEmail({
    to: to,
    subject: '[公告系統] ' + flag + '：' + (c['公告標題'] || c['主旨']),
    htmlBody: [
      '<p><b>' + flag + '</b></p>',
      '<p>發文機關：' + escapeHtml_(c['發文機關']) + '<br>字號：' + escapeHtml_(c['發文字號']) + '</p>',
      '<p>主旨：' + escapeHtml_(c['主旨']) + '</p>',
      '<p>風險：' + risk.level + '　' + escapeHtml_(risk.reasons.join('；')) + '</p>',
      '<p><a href="' + webapp + '">開啟審核台</a></p>'
    ].join('')
  });
}

/** 解析失敗、卡在解析中太久 → 通知（Telegram，傳不出去改寄 email） */
function notifyError_(caseId, msg) {
  let title = '';
  try { const c = getCase_(caseId); title = c['公告標題'] || c['主旨'] || ''; } catch (e) {}
  notify_('處理失敗', (title ? '「' + title + '」' : '案件 ' + caseId) + '\n原因：' + String(msg || '未說明').slice(0, 500) +
          '\n請到審核台按「重新解析」；仍失敗就依備註處理。');
}

/**
 * 送出通知：有設 Telegram（TELEGRAM_BOT_TOKEN＋TELEGRAM_CHAT_ID）就傳 Telegram；
 * 沒設或傳不出去才改寄 email（NOTIFY_EMAIL，沒填就寄給專案擁有者），提醒不會因為 Telegram 出問題就漏掉。
 * subject、text 都是純文字（會自動跳脫），最後附上審核台連結。回傳實際用的管道。
 */
function notify_(subject, text) {
  let url = '';
  try { url = ScriptApp.getService().getUrl(); } catch (e) {}
  const token = prop_('TELEGRAM_BOT_TOKEN', false), chat = prop_('TELEGRAM_CHAT_ID', false);
  if (token && chat) {
    try {
      telegramSend_(token, chat, subject, text, url);
      return 'telegram';
    } catch (e) {
      console.warn('Telegram 傳送失敗，改寄 email：' + e.message);
    }
  }
  const to = prop_('NOTIFY_EMAIL', false) || Session.getEffectiveUser().getEmail();
  if (!to) throw new Error('沒有可用的通知管道（Telegram 沒設好，也找不到信箱）');
  MailApp.sendEmail({
    to: to,
    subject: '[公告系統] ' + subject,
    htmlBody: '<p>' + escapeHtml_(text).replace(/\n/g, '<br>') + '</p>' + (url ? '<p><a href="' + escapeHtml_(url) + '">開啟審核台</a></p>' : '')
  });
  return 'email';
}

/** 用 Telegram 機器人傳一則訊息；失敗丟出錯誤（錯誤訊息裡不會出現 token） */
function telegramSend_(token, chat, subject, text, url) {
  const msg = '<b>' + escapeHtml_('[公告系統] ' + subject) + '</b>\n' + escapeHtml_(String(text || '').slice(0, 3500)) +
              (url ? '\n<a href="' + escapeHtml_(url) + '">開啟審核台</a>' : '');
  let res;
  try {
    res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ chat_id: chat, text: msg, parse_mode: 'HTML', disable_web_page_preview: true })
    });
  } catch (e) {
    throw new Error(String(e.message).split(token).join('***'));
  }
  let j = {};
  try { j = JSON.parse(res.getContentText()); } catch (e) {}
  if (res.getResponseCode() !== 200 || !j.ok) {
    throw new Error('Telegram 回應 ' + res.getResponseCode() + '：' + String(j.description || '').slice(0, 150));
  }
}

/**
 * Telegram 通知設定（在 Apps Script 編輯器選這個函式按「執行」，做一次就好）：
 *   1. Telegram 搜尋 @BotFather → 傳 /newbot → 照指示取名，拿到一串 token
 *   2. 專案設定 → 指令碼屬性 → 新增 TELEGRAM_BOT_TOKEN，值貼上 token
 *   3. 在 Telegram 打開你剛建的機器人，按「開始」（或傳任一句話）
 *   4. 執行 setupTelegram：自動找到你的對話、存成 TELEGRAM_CHAT_ID，並傳一則測試訊息
 */
function setupTelegram() {
  requireReviewer_();
  const token = prop_('TELEGRAM_BOT_TOKEN', false);
  if (!token) throw new Error('請先在「專案設定 → 指令碼屬性」新增 TELEGRAM_BOT_TOKEN（@BotFather 給的 token）。');
  let res;
  try {
    res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates', { muteHttpExceptions: true });
  } catch (e) {
    throw new Error('連不到 Telegram：' + String(e.message).split(token).join('***'));
  }
  let j = {};
  try { j = JSON.parse(res.getContentText()); } catch (e) {}
  if (!j.ok) throw new Error('TELEGRAM_BOT_TOKEN 不對，或機器人不能用（' + (j.description || res.getResponseCode()) + '）。');
  const chats = (j.result || []).map(function (u) { return (u.message || u.edited_message || {}).chat; })
    .filter(function (c) { return c && c.type === 'private'; });
  if (!chats.length) throw new Error('機器人還沒收到你的訊息：請在 Telegram 打開機器人按「開始」或傳一句話，再執行一次。');
  const chat = chats[chats.length - 1];
  PropertiesService.getScriptProperties().setProperty('TELEGRAM_CHAT_ID', String(chat.id));
  let url = '';
  try { url = ScriptApp.getService().getUrl(); } catch (e) {}
  telegramSend_(token, String(chat.id), '通知已連上',
    '之後「處理失敗」「公告助手暫停」「後台登入過期」「核准超過 1 小時還沒發布」都會傳到這裡。', url);
  const who = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || chat.id;
  const msg = '已設定：通知會傳給 Telegram 的「' + who + '」。請到 Telegram 確認有收到測試訊息；名字不是你的話，請告訴 Claude。';
  console.log(msg);
  return msg;
}

/** 傳一則測試通知（在編輯器執行），回傳實際用的管道 */
function testNotify() {
  requireReviewer_();
  const via = notify_('測試通知', '這是一則測試訊息，收到代表通知設定正常。');
  console.log('已用 ' + via + ' 送出');
  return via;
}

// ============================================================
// Bridge.gs
// ============================================================

/**
 * 給瀏覽器腳本用的 JSON 介面
 *
 * 黑快馬後台登入有圖形驗證碼，程式無法登入，所以改由你已登入的瀏覽器來填表。
 * 流程：審核台核准 → 案件停在 APPROVED → 你開後台新增公告頁 →
 *       Tampermonkey 腳本呼叫這裡取回草稿與附件 → 自動填好 → 你按送出。
 *
 * 端點（都掛在 Web App 網址後面）：
 *   ?api=pending            待發布案件清單
 *   ?api=case&id=C...       單一案件完整內容
 *   ?api=file&id=<fileId>   單一附件的 base64
 *   ?api=done&id=C...&url=  標記已發布
 *
 * 安全性：Web App 部署成「僅限自己」，Google 帳號本身就是門禁。
 * 另外可設指令碼屬性 BRIDGE_TOKEN，腳本每次會帶上，當第二道檢查。
 */

function bridgeRoute_(e) {
  requireReviewer_();
  const p = e.parameter || {};
  const token = prop_('BRIDGE_TOKEN', false);
  if (token && p.token !== token) return json_({ ok: false, error: 'token 不符' });

  try {
    switch (p.api) {
      case 'pending': return json_({ ok: true, cases: bridgePending_() });
      case 'case':    return json_({ ok: true, data: bridgeCase_(p.id) });
      case 'file':    return json_({ ok: true, file: bridgeFile_(p.id) });
      case 'done':    return json_({ ok: true, data: bridgeDone_(p.id, p.url || '') });
      // 自動發布模式
      case 'claim':     return json_({ ok: true, data: bridgeClaim_(p.id) });
      case 'submitted': return json_({ ok: true, data: bridgeSubmitted_(p.id, p.url || '', p.note || '') });
      case 'fail':      return json_({ ok: true, data: bridgeFail_(p.id, p.msg || '') });
      case 'verifying': return json_({ ok: true, cases: bridgeVerifying_() });
      case 'beat':      return json_({ ok: true, data: bridgeBeat_(p) });
      case 'diag':    return json_({ ok: true, diag: bridgeDiag_(p.token) });
      default:        return json_({ ok: false, error: '未知的 api 參數：' + p.api });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function bridgePending_() {
  return listCases_([CONFIG.STATUS.APPROVED]).map(function (c) {
    return {
      caseId: c.caseId,
      title: c['公告標題'],
      category: c['建議分類'],
      org: c['發文機關'],
      attachments: publishFiles_(c).length
    };
  });
}

function bridgeCase_(caseId) {
  const c = getCase_(caseId);
  if (c['狀態'] !== CONFIG.STATUS.APPROVED) {
    throw new Error('案件狀態是 ' + c['狀態'] + '，不是待發布');
  }
  return caseData_(c);
}

/** 公告模組代號：主分類 ＋ RPAGE_ALSO_POST_TO，去重 */
function groupIds_(category) {
  const ids = [];
  [category].concat(CONFIG.RPAGE_ALSO_POST_TO || []).forEach(function (name) {
    const id = CONFIG.RPAGE_GROUPS[name];
    if (id && ids.indexOf(id) < 0) ids.push(id);
  });
  return ids;
}

function caseData_(c) {
  return {
    caseId: c.caseId,
    groupIds: groupIds_(c['建議分類']),
    title: c['公告標題'],
    body: sanitizeBody_(c['公告內文']),
    category: c['建議分類'],
    scope: c['適用對象'],
    startDate: fmtDate_(c['公告起日']),
    endDate: fmtDate_(c['公告迄日']),
    org: c['發文機關'],
    docNo: c['發文字號'],
    attachments: publishFiles_(c).map(function (a) {
      return { id: a.id, name: a.name, mime: a.mime, size: a.size, isMain: !!a.isMain };
    })
  };
}

function safeAtts_(c) {
  try { return JSON.parse(c['附件清單'] || '[]'); } catch (e) { return []; }
}

/**
 * 實際要上傳校網的檔案：公文本體（UPLOAD_MAIN_DOC 開啟時，排第一）＋ 附件清單。
 * 公文本體用解析時記下的檔案 ID（核准後才放進資料夾的檔案不會被當成公文本體發出去）；
 * 舊案件沒有記 ID 才從資料夾即時找。檔名一律讀最新的。
 */
function publishFiles_(c) {
  const out = [];
  if (CONFIG.UPLOAD_MAIN_DOC) {
    try {
      let main = null;
      if (c['公文本體ID']) {
        const f = DriveApp.getFileById(c['公文本體ID']);
        if (!f.isTrashed()) main = { id: f.getId(), name: f.getName(), mime: f.getMimeType(), size: f.getSize(), url: f.getUrl() };
      } else {
        main = inspectFolder_(c['資料夾ID']).main;
      }
      if (main) out.push(Object.assign({}, main, { isMain: true }));
    } catch (e) {}
  }
  safeAtts_(c).forEach(function (a) {
    if (!out.some(function (x) { return String(x.id) === String(a.id); })) out.push(a);
  });
  return out;
}

/** 單一附件轉 base64。太大的檔案擋下來，避免 Web App 回應超過上限。 */
function bridgeFile_(fileId) {
  const allowed = listCases_([CONFIG.STATUS.APPROVED, CONFIG.STATUS.SUBMITTING]).some(function (c) {
    return publishFiles_(c).some(function (a) { return String(a.id) === String(fileId); });
  });
  if (!allowed) throw new Error('此檔案不是待發布案件的附件。');
  const f = DriveApp.getFileById(fileId);
  const blob = f.getBlob();
  const bytes = blob.getBytes();
  if (bytes.length > 25 * 1024 * 1024) {
    throw new Error('附件 ' + f.getName() + ' 超過 25MB，請手動上傳');
  }
  return {
    name: f.getName(),
    mime: blob.getContentType(),
    size: bytes.length,
    base64: Utilities.base64Encode(bytes)
  };
}

function bridgeDone_(caseId, url) {
  const c = getCase_(caseId);
  if (c['狀態'] === CONFIG.STATUS.PUBLISHED) return { caseId: caseId, status: CONFIG.STATUS.PUBLISHED };
  if ([CONFIG.STATUS.APPROVED, CONFIG.STATUS.SUBMITTING].indexOf(c['狀態']) < 0) {
    throw new Error('只有已核准案件可以標記發布完成。');
  }
  // 一定要有校網公告網址：沒有網址代表沒確認上架，不能記成已發布
  if (!url || String(url).indexOf(CONFIG.SITE_URL + '/p/') !== 0) throw new Error('請填寫本校網站的公告網址。');
  updateCase_(caseId, {
    '狀態': CONFIG.STATUS.PUBLISHED,
    '發布時間': new Date(),
    '校網網址': url
  });
  try { PropertiesService.getScriptProperties().deleteProperty('CLAIM_' + caseId); } catch (e) {}
  try { moveCaseFolder_(c['資料夾ID'], 'PUBLISHED'); } catch (e) {}
  return { caseId: caseId, status: CONFIG.STATUS.PUBLISHED };
}

/**
 * 自動模式領取案件：APPROVED → SUBMITTING。
 * 用鎖確保同一案件只會被一個分頁／一台電腦領走，避免重複發文。
 */
function bridgeClaim_(caseId) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('系統忙碌，稍後再試');
  try {
    const c = getCase_(caseId);
    if (c['狀態'] !== CONFIG.STATUS.APPROVED) throw new Error('案件狀態是 ' + c['狀態'] + '，已被處理或不是待發布');
    if (c['風險等級'] === '紅' && CONFIG.BLOCK_ON_RED && !isForced_(c)) throw new Error('紅燈案件不自動發布');
    updateCase_(caseId, {
      '狀態': CONFIG.STATUS.SUBMITTING,
      '備註': '自動發布：已領取 ' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm')
    });
    try { PropertiesService.getScriptProperties().setProperty('CLAIM_' + caseId, String(Date.now())); } catch (e) {}
    return caseData_(getCase_(caseId));
  } finally {
    lock.releaseLock();
  }
}

/** 已在後台按下新增：記下預期的公告網址，等校網出現再標成已發布（不會再重送） */
function bridgeSubmitted_(caseId, url, note) {
  const c = getCase_(caseId);
  if (c['狀態'] !== CONFIG.STATUS.SUBMITTING) throw new Error('案件不是送出中狀態');
  if (url && String(url).indexOf(CONFIG.SITE_URL + '/p/') !== 0) throw new Error('網址不是本校公告網址');
  updateCase_(caseId, {
    '校網網址': url,
    // 沒有網址＝不確定有沒有新增成功，要人工到後台確認
    '備註': (url ? '自動發布：已在後台新增 ' : '待人工確認 ') + Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm') +
            (note ? '；' + String(note).slice(0, 200) : '')
  });
  return { caseId: caseId, status: CONFIG.STATUS.SUBMITTING };
}

/** 還沒按新增就失敗（例如欄位找不到）：退回待發布並記下原因，下一輪會重試 */
function bridgeFail_(caseId, msg) {
  const c = getCase_(caseId);
  if (c['狀態'] !== CONFIG.STATUS.SUBMITTING) throw new Error('案件不是送出中狀態');
  if (c['校網網址']) throw new Error('已在後台新增過，不能退回重送，請人工確認');
  updateCase_(caseId, {
    '狀態': CONFIG.STATUS.APPROVED,
    '備註': '自動發布失敗：' + String(msg || '未說明').slice(0, 300)
  });
  try { PropertiesService.getScriptProperties().deleteProperty('CLAIM_' + caseId); } catch (e) {}
  return { caseId: caseId, status: CONFIG.STATUS.APPROVED };
}

/** 已送出、等校網出現的案件 */
function bridgeVerifying_() {
  return listCases_([CONFIG.STATUS.SUBMITTING]).map(function (c) {
    return { caseId: c.caseId, title: c['公告標題'], url: c['校網網址'] || '', note: c['備註'] || '' };
  });
}

/**
 * 診斷端點 — 只回傳運作狀態，不回傳公文內容
 *
 * 用途：部署成「任何人」時，讓外部（例如協助除錯的人）確認系統是否正常，
 * 而不會洩漏任何公文、標題或附件。必須設定 BRIDGE_TOKEN 才會回應。
 *
 * 回傳的東西僅限於：各狀態的案件數量、最近幾筆的狀態與錯誤訊息、
 * 設定項目是否存在（只回 true/false，不回內容）、觸發器是否安裝。
 */
function bridgeDiag_(token) {
  const want = prop_('BRIDGE_TOKEN', false);
  if (!want) throw new Error('未設定 BRIDGE_TOKEN，診斷端點停用');
  if (token !== want) throw new Error('token 不符');

  const all = listCases_(null);
  const counts = {};
  all.forEach(function (c) {
    const s = c['狀態'] || '(空白)';
    counts[s] = (counts[s] || 0) + 1;
  });

  // 只取狀態與錯誤訊息，標題與內文一律不回
  const recent = all.slice(0, 10).map(function (c) {
    return {
      caseId: c.caseId,
      status: c['狀態'],
      risk: c['風險等級'],
      created: c['建立時間'] ? Utilities.formatDate(new Date(c['建立時間']), 'Asia/Taipei', 'MM-dd HH:mm') : '',
      attachments: safeAtts_(c).length,
      note: String(c['備註'] || '').slice(0, 300)
    };
  });

  const triggers = ScriptApp.getProjectTriggers().map(function (t) {
    return t.getHandlerFunction();
  });

  return {
    time: Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss'),
    totalCases: all.length,
    counts: counts,
    recent: recent,
    config: {
      apiKey: !!prop_('ANTHROPIC_API_KEY', false),
      notifyEmail: !!prop_('NOTIFY_EMAIL', false),
      sheet: !!prop_('SHEET_ID', false),
      folders: ['INBOX', 'WORKING', 'REVIEW', 'PUBLISHED', 'REJECTED']
        .every(function (k) { return !!prop_('FOLDER_' + k, false); }),
      autoPublish: CONFIG.AUTO_PUBLISH_ON_APPROVE,
      blockOnRed: CONFIG.BLOCK_ON_RED,
      model: CONFIG.CLAUDE_MODEL
    },
    triggers: triggers
  };
}

/** 產生一組隨機 BRIDGE_TOKEN 並存起來，執行後看執行紀錄 */
function makeBridgeToken() {
  requireReviewer_();
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let t = '';
  for (let i = 0; i < 40; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
  setProp_('BRIDGE_TOKEN', t);
  Logger.log('BRIDGE_TOKEN 已產生並存入指令碼屬性：\n' + t);
  return t;
}

/** 產生腳本要填的設定，執行後看執行紀錄 */
function bridgeInfo() {
  requireReviewer_();
  const url = ScriptApp.getService().getUrl();
  const token = prop_('BRIDGE_TOKEN', false);
  const txt = [
    'Web App 網址：' + (url || '（尚未部署，先去「部署 → 新增部署作業 → 網頁應用程式」）'),
    'BRIDGE_TOKEN：' + (token || '（未設定，可留空）'),
    '',
    '把上面兩個值填進 Tampermonkey 腳本的設定面板即可。'
  ].join('\n');
  Logger.log(txt);
  return txt;
}

// ============================================================
// Publisher.gs
// ============================================================

/**
 * 黑快馬 Rpage 校網發布模組
 *
 * Apps Script 沒有瀏覽器，所以是用 UrlFetchApp 直接模擬後台的 HTTP 請求：
 * 先 POST 登入拿 session cookie，再把公告欄位與附件以 multipart 送出。
 *
 * ⚠ 後台的網址與欄位名稱只有登入後看得到，必須先填進設定才會動。
 *    做法：先執行 rpageProbe()，它會把登入頁與新增公告頁的所有表單欄位印出來，
 *    再把結果填進下面的 RPAGE_CONFIG（存成指令碼屬性 RPAGE_CONFIG 的 JSON）。
 */

/** 預設骨架。實際值請用指令碼屬性 RPAGE_CONFIG 覆蓋，不要把網址寫死在程式裡。 */
const RPAGE_DEFAULT = {
  loginUrl:     '',   // 後台登入頁，例：https://www.dgejh.ntpc.edu.tw/bin/home.php
  loginPostUrl: '',   // 登入表單 action，留空就 POST 回 loginUrl
  userField:    'account',
  passField:    'password',
  csrfField:    '',   // 有隱藏 token 就填欄位名
  extraLoginFields: {},
  loginSuccessHint: '登出',   // 登入後頁面一定會出現的字，用來確認登入成功

  newUrl:       '',   // 新增公告頁網址
  postUrl:      '',   // 新增公告表單 action
  fields: {           // 系統欄位 → 後台表單欄位名
    title:     'subject',
    body:      'content',
    category:  'cate',
    startDate: 'sdate',
    endDate:   'edate',
    file:      'file[]'
  },
  categoryValues: {}, // 例：{"行政公告":"45","最新消息":"10"}
  staticFields: {},   // 表單上固定要帶的隱藏欄位
  successHint: '新增成功',
  urlPattern: /\/p\/406-1000-(\d+)/   // 從回應抓新公告編號
};

function rpageConfig_() {
  const raw = prop_('RPAGE_CONFIG', false);
  if (!raw) {
    throw new Error(
      '尚未設定 RPAGE_CONFIG。請先執行 rpageProbe() 取得後台表單欄位，' +
      '再把設定 JSON 存進指令碼屬性 RPAGE_CONFIG。'
    );
  }
  const cfg = Object.assign({}, RPAGE_DEFAULT, JSON.parse(raw));
  cfg.fields = Object.assign({}, RPAGE_DEFAULT.fields, cfg.fields || {});
  if (!cfg.loginUrl || !cfg.postUrl) throw new Error('RPAGE_CONFIG 缺少 loginUrl 或 postUrl');
  return cfg;
}

// ---------- Cookie 管理 ----------

function absorbCookies_(jar, res) {
  const all = res.getAllHeaders()['Set-Cookie'];
  if (!all) return;
  (Array.isArray(all) ? all : [all]).forEach(function (c) {
    const kv = c.split(';')[0].split('=');
    if (kv.length >= 2) jar[kv[0].trim()] = kv.slice(1).join('=').trim();
  });
}

function cookieHeader_(jar) {
  return Object.keys(jar).map(function (k) { return k + '=' + jar[k]; }).join('; ');
}

function extractInput_(html, name) {
  const re = new RegExp('<input[^>]*name=["\']' + name + '["\'][^>]*value=["\']([^"\']*)["\']', 'i');
  const m = html.match(re);
  return m ? m[1] : '';
}

// ---------- 登入 ----------

function rpageLogin_() {
  const cfg = rpageConfig_();
  const jar = {};

  let res = UrlFetchApp.fetch(cfg.loginUrl, {
    muteHttpExceptions: true, followRedirects: false
  });
  absorbCookies_(jar, res);
  const html = res.getContentText();

  const payload = {};
  payload[cfg.userField] = prop_('RPAGE_USER', true);
  payload[cfg.passField] = prop_('RPAGE_PASS', true);
  if (cfg.csrfField) {
    const t = extractInput_(html, cfg.csrfField);
    if (t) payload[cfg.csrfField] = t;
  }
  Object.keys(cfg.extraLoginFields || {}).forEach(function (k) {
    payload[k] = cfg.extraLoginFields[k];
  });

  res = UrlFetchApp.fetch(cfg.loginPostUrl || cfg.loginUrl, {
    method: 'post',
    payload: payload,
    headers: { Cookie: cookieHeader_(jar) },
    muteHttpExceptions: true,
    followRedirects: false
  });
  absorbCookies_(jar, res);

  // 跟隨一次轉址確認登入狀態
  let verify = res.getContentText();
  const loc = res.getAllHeaders()['Location'];
  if (loc) {
    const r2 = UrlFetchApp.fetch(absolute_(loc, cfg.loginUrl), {
      headers: { Cookie: cookieHeader_(jar) }, muteHttpExceptions: true
    });
    absorbCookies_(jar, r2);
    verify = r2.getContentText();
  }

  if (cfg.loginSuccessHint && verify.indexOf(cfg.loginSuccessHint) < 0) {
    throw new Error('後台登入失敗，請確認 RPAGE_USER / RPAGE_PASS，或後台是否加了驗證碼');
  }
  return jar;
}

function absolute_(href, base) {
  if (/^https?:\/\//.test(href)) return href;
  const root = base.match(/^https?:\/\/[^\/]+/)[0];
  return href.charAt(0) === '/' ? root + href : base.replace(/\/[^\/]*$/, '/') + href;
}

// ---------- 發布 ----------

function publishCase_(caseId) {
  const cfg = rpageConfig_();
  const c = getCase_(caseId);
  const jar = rpageLogin_();

  // 取隱藏欄位（部分後台每次新增都會帶一次性 token）
  let hidden = {};
  if (cfg.newUrl) {
    const r = UrlFetchApp.fetch(cfg.newUrl, {
      headers: { Cookie: cookieHeader_(jar) }, muteHttpExceptions: true
    });
    absorbCookies_(jar, r);
    const h = r.getContentText();
    Object.keys(cfg.staticFields || {}).forEach(function (k) {
      const v = extractInput_(h, k);
      hidden[k] = v || cfg.staticFields[k];
    });
    if (cfg.csrfField) {
      const t = extractInput_(h, cfg.csrfField);
      if (t) hidden[cfg.csrfField] = t;
    }
  } else {
    hidden = Object.assign({}, cfg.staticFields || {});
  }

  const F = cfg.fields;
  const payload = Object.assign({}, hidden);
  payload[F.title] = c['公告標題'];
  payload[F.body] = sanitizeBody_(c['公告內文']);
  payload[F.category] = (cfg.categoryValues || {})[c['建議分類']] || c['建議分類'];
  if (F.startDate) payload[F.startDate] = fmtDate_(c['公告起日']);
  if (F.endDate) payload[F.endDate] = fmtDate_(c['公告迄日']);

  // 附件：UrlFetchApp 遇到 Blob 會自動改用 multipart/form-data
  let atts = [];
  try { atts = JSON.parse(c['附件清單'] || '[]'); } catch (e) {}
  atts.forEach(function (a, i) {
    const name = F.file.indexOf('[]') >= 0 ? F.file.replace('[]', '[' + i + ']') : F.file + (i || '');
    payload[name] = DriveApp.getFileById(a.id).getBlob();
  });

  const res = UrlFetchApp.fetch(cfg.postUrl, {
    method: 'post',
    payload: payload,
    headers: { Cookie: cookieHeader_(jar), Referer: cfg.newUrl || cfg.loginUrl },
    muteHttpExceptions: true,
    followRedirects: true
  });

  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code >= 400) throw new Error('後台回應 ' + code);
  if (cfg.successHint && body.indexOf(cfg.successHint) < 0 && code !== 302) {
    throw new Error('送出後找不到成功訊息，請人工確認是否已新增。回應開頭：' + body.slice(0, 200));
  }

  let url = '';
  const m = body.match(cfg.urlPattern instanceof RegExp ? cfg.urlPattern : new RegExp(cfg.urlPattern));
  if (m) url = CONFIG.SITE_URL + '/p/406-1000-' + m[1] + '.php';

  updateCase_(caseId, {
    '狀態': CONFIG.STATUS.PUBLISHED,
    '發布時間': new Date(),
    '校網網址': url
  });
  try { moveCaseFolder_(c['資料夾ID'], 'PUBLISHED'); } catch (e) {}
  return url;
}

// ---------- 設定輔助 ----------

/**
 * 執行這個函式，把後台表單結構印出來。
 * 先在指令碼屬性放一個最小的 RPAGE_CONFIG，至少要有 loginUrl；
 * 想看新增公告頁就再加 newUrl。結果在「執行紀錄」裡。
 */
function rpageProbe() {
  const cfg = Object.assign({}, RPAGE_DEFAULT, JSON.parse(prop_('RPAGE_CONFIG', false) || '{}'));
  if (!cfg.loginUrl) return '請先在 RPAGE_CONFIG 填 loginUrl';

  const out = [];
  const r1 = UrlFetchApp.fetch(cfg.loginUrl, { muteHttpExceptions: true, followRedirects: false });
  out.push('=== 登入頁 ' + cfg.loginUrl + ' (' + r1.getResponseCode() + ') ===');
  out.push(dumpForms_(r1.getContentText()));

  if (cfg.newUrl) {
    try {
      const jar = rpageLogin_();
      const r2 = UrlFetchApp.fetch(cfg.newUrl, {
        headers: { Cookie: cookieHeader_(jar) }, muteHttpExceptions: true
      });
      out.push('');
      out.push('=== 新增公告頁 ' + cfg.newUrl + ' (' + r2.getResponseCode() + ') ===');
      out.push(dumpForms_(r2.getContentText()));
    } catch (e) {
      out.push('無法登入後台：' + e.message);
    }
  }

  const txt = out.join('\n');
  Logger.log(txt);
  return txt;
}

/** 把 HTML 裡所有 form / input / select 的名稱印出來 */
function dumpForms_(html) {
  const lines = [];
  const forms = html.match(/<form[\s\S]*?<\/form>/gi) || [];
  if (!forms.length) lines.push('(找不到 <form>，可能是 JavaScript 動態產生，需要改用瀏覽器抓請求)');

  forms.forEach(function (f, i) {
    const act = (f.match(/action=["']([^"']*)["']/i) || [])[1] || '(同頁)';
    const met = (f.match(/method=["']([^"']*)["']/i) || [])[1] || 'get';
    lines.push('[form ' + i + '] ' + met.toUpperCase() + ' → ' + act);

    (f.match(/<input[^>]*>/gi) || []).forEach(function (t) {
      const n = (t.match(/name=["']([^"']*)["']/i) || [])[1];
      const ty = (t.match(/type=["']([^"']*)["']/i) || [])[1] || 'text';
      const v = (t.match(/value=["']([^"']*)["']/i) || [])[1] || '';
      if (n) lines.push('   input  ' + n + '  (' + ty + ')' + (v ? '  = ' + v.slice(0, 40) : ''));
    });

    (f.match(/<select[\s\S]*?<\/select>/gi) || []).forEach(function (s) {
      const n = (s.match(/name=["']([^"']*)["']/i) || [])[1];
      const opts = (s.match(/<option[^>]*value=["']([^"']*)["'][^>]*>([^<]*)/gi) || [])
        .slice(0, 20)
        .map(function (o) {
          const mm = o.match(/value=["']([^"']*)["'][^>]*>([^<]*)/i);
          return mm ? mm[1] + '=' + mm[2].trim() : '';
        });
      if (n) lines.push('   select ' + n + '  → ' + opts.join(' | '));
    });

    (f.match(/<textarea[^>]*>/gi) || []).forEach(function (t) {
      const n = (t.match(/name=["']([^"']*)["']/i) || [])[1];
      if (n) lines.push('   textarea ' + n);
    });
  });
  return lines.join('\n');
}

/** 不碰校網、只驗證登入是否成功 */
function testLogin() {
  try {
    rpageLogin_();
    return '登入成功。';
  } catch (e) {
    return '登入失敗：' + e.message;
  }
}
