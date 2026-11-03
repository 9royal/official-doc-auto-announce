// ==UserScript==
// @name         公文公告助手
// @namespace    school-announce-helper
// @version      1.8
// @description  黑快馬後台公告模組：核准後自動發布，或手動帶入已核准的公告草稿與附件
// @match        https://www.dgejh.ntpc.edu.tw/platform/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

// 【布建時看這裡】不是達觀的老師：把上面 @match 那一行的網址換成你學校的校網後台，
// 例如 https://www.xxx.ntpc.edu.tw/platform/*，其他都不用改。

/*
 * 第一次使用：
 *  1. 先用同一個瀏覽器打開一次審核台網址，確認看得到審核台（代表 Google 已登入）
 *  2. 打開後台的「新增公告」頁，點右下角「公告助手」開啟面板（網址已預填）
 *  3. 欄位對應：依序按標題、分類、起日、迄日、附件旁的「對應」，再點頁面上對應的欄位
 *  4. 按「偵測編輯器」，選內文要填進去的編輯器
 * 對應只做一次，之後存在瀏覽器裡。黑快馬改版導致填不進去時，重做一次對應即可。
 *
 * 1.1 修正：頁框代號改成依頁框位置產生（1.0 每次載入都是亂數，重新整理後就填不進去）；
 *          點選對應後其他頁框會一起結束點選模式；填不到時會明確報錯；
 *          日期依欄位格式自動轉成 yyyy/MM/dd 或民國年。
 * 1.2 修正：面板改放 Shadow DOM，黑快馬後台的 CSS 會把按鈕文字蓋掉，現在不會了。
 *          已做好的欄位對應沿用，不用重做。
 * 1.5 修正：新增資訊視窗的 id 每次不同（fullDiv10／fullDiv12…），改成從欄位往上找；
 *          上次中斷留下的空白視窗會先關掉；視窗裡有人在填資料時不動它、等下一輪。
 * 1.4 自動發布模式：審核台核准後，開著的後台分頁會自己開新增資訊、用 HTML 模式填內文、
 *          勾選公告模組、上傳公文與附件、按「新增並返回」，再到校網確認出現才標成已發布。
 *          預設關閉；遇到錯誤或登入過期會自動暫停。另有「試跑」只填表不送出。
 * 1.3 公文本體也一起上傳（排第一個）；附件一格放一個檔，格子不夠自動按「上傳更多附件」，
 *          不會放進「批量上傳」；Word/Excel/PPT 缺 ODF 版本時提醒；
 *          修正下載附件期間其他欄位的回報可能漏收；
 *          「標記完成」改成面板內貼網址，沒有校網公告網址就不會標記（不再用 prompt 視窗）。
 * 1.6 防止重複發文：「帶入這則公告」會先領取案件（變成送出中），自動模式不會再發一次；
 *          手動按完「新增並返回」後自動找到新公告、記下網址，校網出現就標成已發布。
 *          按了新增但結果不明（視窗沒關、沒有錯誤訊息）時不再退回待發布，改成交給人工確認。
 *          清單也列出「送出中」的案件，可以直接貼網址標記完成。
 *          修正只有編號、沒有原檔名的附件被誤報缺 ODF。
 * 1.7 每一輪回報狀態給系統：審核台頂端看得到公告助手是否在運作；暫停或後台登入過期會寄信提醒。
 *          在跑但送不出去（不在公告模組頁、新增視窗開著）回報「卡住」，核准的公告等太久會寄信。
 *          開了好幾個後台分頁時只有做事的那個分頁回報，停在登入頁的舊分頁不會誤報登入過期。
 *          頁框之間的訊息只收、只送同一個網站，別的網站嵌進來的頁框無法下指令。
 * 1.8 面板標題旁加上 Ro 品牌符號。
 */

(function () {
  'use strict';

  const DEFAULT_URL = '';   // 第一次使用時在「公告助手」面板貼上自己的 Web App 網址

  const FIELDS = [
    { key: 'title',     label: '公告標題',  hint: '點選標題的輸入框' },
    { key: 'category',  label: '分類',      hint: '點選分類的下拉選單' },
    { key: 'startDate', label: '公告起日',  hint: '點選起日欄位' },
    { key: 'endDate',   label: '公告迄日',  hint: '點選迄日欄位' },
    { key: 'file',      label: '附件',      hint: '點選附件的檔案選擇欄位' }
  ];

  const IS_TOP = window.top === window.self;

  /**
   * 頁框代號：必須每次載入都一樣，對應存下來之後才找得回同一個頁框。
   * 用「網址路徑 + 頁框名稱（沒有名稱就用在父頁的順序）」組成。
   */
  function frameKey() {
    if (IS_TOP) return 'top';
    let name = '';
    try { name = window.name || ''; } catch (e) {}
    let idx = -1;
    try {
      const sibs = window.parent.frames;
      for (let i = 0; i < sibs.length; i++) if (sibs[i] === window) { idx = i; break; }
    } catch (e) {}
    return location.pathname + '#' + (name || idx);
  }
  const FRAME_ID = frameKey();

  // ============================================================
  // 所有 frame 都跑的部分：接收指令、點選對應、填值
  // ============================================================

  // 頁框之間的訊息只收同一個網站（校網後台）送來的，別的網站嵌進來的頁框送什麼都不理
  const sameSite = ev => ev.origin === location.origin;

  window.addEventListener('message', function (ev) {
    const m = ev.data;
    if (!m || m.__dgejh !== true || !sameSite(ev)) return;

    if (m.type === 'who') {
      reply(ev, { type: 'hello', frameId: FRAME_ID, url: location.href });
    }
    else if (m.type === 'pick-start' && (!m.frameId || m.frameId === FRAME_ID)) {
      startPick(m.field, m.hint, ev);
    }
    else if (m.type === 'pick-stop') {
      stopPick();
    }
    else if (m.type === 'detect-editors') {
      reply(ev, { type: 'editors', frameId: FRAME_ID, list: detectEditors() });
    }
    else if (m.type === 'fill' && m.frameId === FRAME_ID) {
      let err = null;
      try { applyFill(m.field, m.value, m.selector); } catch (e) { err = e.message; }
      reply(ev, { type: 'fill-done', field: m.field, error: err });
    }
    else if (m.type === 'set-editor' && m.frameId === FRAME_ID) {
      let err = null;
      try { setEditor(m.editorKey, m.html); } catch (e) { err = e.message; }
      reply(ev, { type: 'fill-done', field: 'body', error: err });
    }
    else if (m.type === 'attach' && m.frameId === FRAME_ID) {
      attachFiles(m.selector, m.files).then(
        function () { reply(ev, { type: 'fill-done', field: 'file', error: null }); },
        function (e) { reply(ev, { type: 'fill-done', field: 'file', error: e.message }); }
      );
    }
  });

  function reply(ev, data) {
    data.__dgejh = true;
    (ev.source || window.top).postMessage(data, location.origin);
  }

  function send(target, data) {
    data.__dgejh = true;
    target.postMessage(data, location.origin);   // 只送給同網站的頁框
  }

  /** 這個視窗與它底下所有子頁框（跨網域也拿得到 window 參照，只是不能讀內容） */
  function allWindows(w, out) {
    out = out || [];
    out.push(w);
    try {
      for (let i = 0; i < w.frames.length; i++) allWindows(w.frames[i], out);
    } catch (e) {}
    return out;
  }

  /** 廣播給整頁所有頁框；收到的頁框自己比對 frameId 決定要不要動作 */
  function broadcast(data) {
    allWindows(window.top).forEach(function (w) {
      try { send(w, Object.assign({}, data)); } catch (e) {}
    });
  }

  // ---------- 點選對應 ----------

  let pickState = null;

  function startPick(field, hint, ev) {
    if (pickState) stopPick();
    // 用自訂標籤名稱，後台針對 div 的樣式不會套到；all:initial 再把繼承的樣式清掉
    const box = document.createElement('dgejh-pickbox');
    box.style.cssText =
      'all:initial;display:block;position:fixed;z-index:2147483646;pointer-events:none;' +
      'border:2px solid #d93025;background:rgba(217,48,37,.12);border-radius:3px;transition:all .05s';
    document.body.appendChild(box);

    const tip = document.createElement('dgejh-picktip');
    tip.textContent = hint + '（Esc 取消）';
    tip.style.cssText =
      'all:initial;display:block;position:fixed;z-index:2147483647;left:50%;top:14px;' +
      'transform:translateX(-50%);background:#202124;color:#fff;padding:8px 16px;border-radius:7px;' +
      'font:14px "Microsoft JhengHei",sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3);pointer-events:none';
    document.body.appendChild(tip);

    const onMove = function (e) {
      const el = e.target;
      if (!el || el === box) return;
      const r = el.getBoundingClientRect();
      box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
      box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    };
    const onClick = function (e) {
      e.preventDefault(); e.stopPropagation();
      const sel = cssPath(e.target);
      stopPick();
      reply(ev, { type: 'picked', field: field, selector: sel, frameId: FRAME_ID });
    };
    const onKey = function (e) {
      if (e.key === 'Escape') { stopPick(); reply(ev, { type: 'picked', field: field, selector: null }); }
    };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    pickState = { box: box, tip: tip, onMove: onMove, onClick: onClick, onKey: onKey };
  }

  function stopPick() {
    if (!pickState) return;
    document.removeEventListener('mousemove', pickState.onMove, true);
    document.removeEventListener('click', pickState.onClick, true);
    document.removeEventListener('keydown', pickState.onKey, true);
    pickState.box.remove(); pickState.tip.remove();
    pickState = null;
  }

  /** 產生夠穩定的 CSS 選擇器 */
  function cssPath(el) {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
      return '#' + CSS.escape(el.id);
    }
    if (el.name) {
      const byName = '[name="' + el.name + '"]';
      if (document.querySelectorAll(byName).length === 1) return byName;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      const sibs = [...node.parentNode.children].filter(x => x.tagName === node.tagName);
      if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      parts.unshift(part);
      node = node.parentNode;
    }
    return parts.join(' > ');
  }

  // ---------- 填值 ----------

  function applyFill(field, value, selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(field + ' 找不到欄位，請重新對應');

    if ((field === 'startDate' || field === 'endDate') && el.type !== 'date') {
      value = adaptDate(value, el);
    }

    if (el.tagName === 'SELECT') {
      const opts = [...el.options];
      const hit = opts.find(o => o.text.trim() === value) ||
                  opts.find(o => o.value === value) ||
                  opts.find(o => o.text.indexOf(value) >= 0);
      if (!hit) throw new Error('分類下拉找不到「' + value + '」');
      el.value = hit.value;
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * 系統給的是 yyyy-MM-dd。依欄位現有的值或提示文字判斷後台要的格式：
   *   有「/」→ yyyy/MM/dd；年份只有 3 位 → 民國年。看不出來就維持原樣。
   */
  function adaptDate(iso, el) {
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return iso;
    const sample = String(el.value || el.placeholder || el.getAttribute('data-date-format') || '');
    const sep = sample.indexOf('/') >= 0 ? '/' : '-';
    const roc = /^\d{3}[\/\-.]/.test(sample) || /民國/.test(sample);
    const y = roc ? String(Number(m[1]) - 1911) : m[1];
    return y + sep + m[2] + sep + m[3];
  }

  /** 找出頁面上可以放 HTML 內文的目標 */
  function detectEditors() {
    const out = [];
    const tm = window.tinymce || window.tinyMCE;
    if (tm && tm.editors) {
      tm.editors.forEach(function (ed, i) {
        out.push({ key: 'tinymce:' + (ed.id || i), label: 'TinyMCE 編輯器 ' + (ed.id || i) });
      });
    }
    if (window.CKEDITOR && window.CKEDITOR.instances) {
      Object.keys(window.CKEDITOR.instances).forEach(function (k) {
        out.push({ key: 'ckeditor:' + k, label: 'CKEditor ' + k });
      });
    }
    [...document.querySelectorAll('iframe')].forEach(function (f, i) {
      try {
        if (f.contentDocument && f.contentDocument.body && f.contentDocument.body.isContentEditable) {
          out.push({ key: 'iframe:' + i, label: '編輯器 iframe #' + i });
        }
      } catch (e) {}
    });
    [...document.querySelectorAll('[contenteditable="true"]')].forEach(function (d, i) {
      out.push({ key: 'ce:' + i, label: '可編輯區塊 #' + i });
    });
    [...document.querySelectorAll('textarea')].forEach(function (t, i) {
      out.push({ key: 'textarea:' + i, label: 'textarea ' + (t.name || '#' + i) });
    });
    return out;
  }

  function setEditor(key, html) {
    const [kind, id] = key.split(':');
    if (kind === 'tinymce') {
      const tm = window.tinymce || window.tinyMCE;
      const ed = tm.get(id) || tm.editors[Number(id)];
      if (!ed) throw new Error('找不到 TinyMCE 編輯器');
      ed.setContent(html);
      if (ed.save) ed.save();
    } else if (kind === 'ckeditor') {
      window.CKEDITOR.instances[id].setData(html);
    } else if (kind === 'iframe') {
      const f = document.querySelectorAll('iframe')[Number(id)];
      f.contentDocument.body.innerHTML = html;
    } else if (kind === 'ce') {
      document.querySelectorAll('[contenteditable="true"]')[Number(id)].innerHTML = html;
    } else if (kind === 'textarea') {
      const t = document.querySelectorAll('textarea')[Number(id)];
      t.value = html;
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      throw new Error('不認得的編輯器類型');
    }
  }

  function toFile(f) {
    const bin = atob(f.base64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new File([buf], f.name, { type: f.mime || 'application/octet-stream' });
  }

  function putFiles(input, list) {
    const dt = new DataTransfer();
    list.forEach(function (f) { dt.items.add(toFile(f)); });
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** 「批量上傳」的 zip 欄位不能拿來放一般附件 */
  function isBatchInput(i) {
    if (/zip/i.test(i.accept || '')) return true;
    if (/zip|batch|bulk/i.test((i.name || '') + ' ' + (i.id || ''))) return true;
    const cell = i.closest('td,th,li,label,p,span');
    return !!(cell && /批量|批次|壓縮/.test(cell.textContent || ''));
  }

  /** 和對應到的那一格同一組的單檔上傳欄位（依名稱規則，不行就同一個表單） */
  function fileSlots(first) {
    const base = n => String(n || '').replace(/\[\d*\]$/, '').replace(/[_-]?\d+$/, '');
    const all = [...document.querySelectorAll('input[type="file"]')].filter(i => !i.disabled);
    const from = all.indexOf(first);
    let slots = all.filter((i, k) => k >= from && !isBatchInput(i) &&
      (i === first || (base(first.name) && base(i.name) === base(first.name))));
    if (slots.length <= 1) {
      // 備援：同一表單、同樣 accept 的欄位（避免放進圖片欄位）
      const scope = first.form || document;
      slots = all.filter((i, k) => k >= from && !isBatchInput(i) && scope.contains(i) &&
        (i.accept || '') === (first.accept || ''));
    }
    return slots;
  }

  function findMoreButton() {
    const hit = e => /^(上傳更多附件|更多附件|新增附件|增加附件)$/.test(
      (e.tagName === 'INPUT' ? e.value : e.textContent || '').trim());
    // 先找真正的按鈕或連結；外層包著的 div 文字一樣，但點它不會觸發
    const real = [...document.querySelectorAll('a,button,input[type="button"],input[type="submit"]')].find(hit);
    if (real) return real;
    return [...document.querySelectorAll('span,div')]
      .filter(hit)
      .find(e => ![...e.querySelectorAll('*')].some(hit));   // 取最內層
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /**
   * 黑快馬附件頁是一格只能選一個檔案的「上傳附件」欄位，旁邊有「上傳更多附件」。
   * 一格放一個檔案，格子不夠就按「上傳更多附件」再放；欄位可多選時就全部放同一格。
   */
  async function attachFiles(selector, files) {
    const first = document.querySelector(selector);
    if (!first) throw new Error('找不到附件欄位，請重新對應');
    if (first.type !== 'file') {
      throw new Error('對應到的不是檔案欄位，這個後台可能用自訂上傳元件，附件請手動上傳');
    }
    if (first.multiple || files.length === 1) { putFiles(first, files); return; }

    let slots = fileSlots(first);
    for (let guard = 0; slots.length < files.length && guard < 30; guard++) {
      const more = findMoreButton();
      if (!more) break;
      more.click();
      await sleep(200);
      slots = fileSlots(first);
    }
    files.forEach(function (f, k) { if (slots[k]) putFiles(slots[k], [f]); });
    if (slots.length < files.length) {
      const left = files.slice(slots.length).map(f => f.name);
      throw new Error('已放入 ' + slots.length + ' 個，還有 ' + left.length + ' 個沒有欄位可放，請手動上傳：' +
        left.join('、'));
    }
  }

  if (!IS_TOP) return;   // 以下只在最上層執行

  // ============================================================
  // 最上層：面板與流程控制
  // ============================================================

  const cfg = {
    get url()      { return GM_getValue('url', DEFAULT_URL); },
    set url(v)     { GM_setValue('url', v); },
    get token()    { return GM_getValue('token', ''); },
    set token(v)   { GM_setValue('token', v); },
    get map()      { return JSON.parse(GM_getValue('map', '{}')); },
    set map(v)     { GM_setValue('map', JSON.stringify(v)); },
    get editor()   { return JSON.parse(GM_getValue('editor', 'null')); },
    set editor(v)  { GM_setValue('editor', JSON.stringify(v)); }
  };

  function api(params) {
    return new Promise(function (resolve, reject) {
      if (!cfg.url) return reject(new Error('還沒設定 Web App 網址'));
      const q = Object.assign({}, params);
      if (cfg.token) q.token = cfg.token;
      const qs = Object.keys(q).map(k => k + '=' + encodeURIComponent(q[k])).join('&');
      GM_xmlhttpRequest({
        method: 'GET',
        url: cfg.url + (cfg.url.indexOf('?') >= 0 ? '&' : '?') + qs,
        onload: function (r) {
          let j;
          try { j = JSON.parse(r.responseText); }
          catch (e) {
            return reject(new Error(
              '回應不是 JSON。多半是 Google 要求登入：先用同一個瀏覽器打開一次 Web App 網址，' +
              '確認看得到審核台，再回來重試。若瀏覽器同時登入多個 Google 帳號，' +
              '請確認預設帳號就是專案擁有者。'
            ));
          }
          j.ok ? resolve(j) : reject(new Error(j.error));
        },
        onerror: function () { reject(new Error('連線失敗，確認網址是否正確')); }
      });
    });
  }

  // ---------- UI ----------

  // 面板放在 Shadow DOM 裡：後台自己的 CSS（例如把 button 文字藏起來）碰不到面板。
  // 1.1 以前直接掛在 body，黑快馬後台會把按鈕文字整個蓋掉。
  const host = document.createElement('dgejh-helper');
  const shadow = host.attachShadow({ mode: 'open' });
  const panel = document.createElement('div');
  panel.id = 'dgejh-panel';
  panel.innerHTML = `
    <style>
      :host{all:initial !important;position:fixed !important;right:18px !important;bottom:18px !important;
        z-index:2147483000 !important;display:block !important}
      #dgejh-panel{position:relative;
        font:14px/1.6 "Noto Sans TC","Microsoft JhengHei",sans-serif;color:#202124;text-align:left}
      #dgejh-panel *{box-sizing:border-box}
      #dgejh-panel button{font:inherit;font-size:14px;color:#202124;text-indent:0;letter-spacing:normal;
        visibility:visible;opacity:1;line-height:1.4}
      #dgejh-fab{background:#1a5fb4;color:#fff !important;border:none;border-radius:26px;padding:12px 20px;
        font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}
      #dgejh-body{display:none;position:absolute;right:0;bottom:56px;width:340px;background:#fff;
        border:1px solid #dadce0;border-radius:12px;box-shadow:0 10px 32px rgba(0,0,0,.22);
        padding:16px;max-height:78vh;overflow:auto}
      #dgejh-panel.open #dgejh-body{display:block}
      #dgejh-panel h3{margin:0 0 10px;font-size:15px}
      #dgejh-panel .dg-head{display:flex;align-items:center;gap:8px;margin:0 0 10px}
      #dgejh-panel .dg-head h3{margin:0}
      #dgejh-panel .dg-brand{height:24px;width:auto;flex:none;display:block}
      #dgejh-panel label{display:block;font-size:12px;color:#5f6368;margin:10px 0 3px;font-weight:600}
      #dgejh-panel input,#dgejh-panel select{width:100%;padding:7px 9px;border:1px solid #dadce0;
        border-radius:6px;font:inherit}
      #dgejh-panel button.act{width:100%;margin-top:10px;padding:9px;border-radius:7px;
        border:1px solid #dadce0;background:#fff;font:inherit;font-weight:600;cursor:pointer}
      #dgejh-panel button.act.go{background:#1a5fb4;border-color:#1a5fb4;color:#fff}
      #dgejh-panel .row button{padding:3px 10px;border:1px solid #dadce0;border-radius:5px;
        background:#fff;cursor:pointer;font-size:13px}
      #dgejh-panel .row{display:flex;gap:8px;align-items:center;padding:5px 0;font-size:13px;
        border-top:1px solid #f1f3f4}
      #dgejh-panel .ok{color:#1e8e3e;font-weight:700}
      #dgejh-panel .no{color:#d93025;font-weight:700}
      #dgejh-msg{margin-top:10px;font-size:13px;padding:8px 10px;border-radius:6px;display:none;white-space:pre-line}
      #dgejh-msg.show{display:block}
      #dgejh-msg.err{background:#fce8e6;color:#c5221f}
      #dgejh-msg.okm{background:#e6f4ea;color:#137333}
      #dgejh-msg.warn{background:#fef7e0;color:#8a5a00}
      #dgejh-panel .sub{font-size:12px;color:#5f6368}
    </style>
    <button id="dgejh-fab">公告助手</button>
    <div id="dgejh-body">
      <div class="dg-head">
      <svg class="dg-brand" viewBox="0 280 520 334" role="img" aria-label="Ro">
      <defs>
      <clipPath id="dg-ro-clip">
      <path d="M 391 482 L 515.68 482 L 515.68 614 L 391 614 Z M 391 482"/>
      </clipPath>
      </defs>
      <path fill="#231816" d="M 351.05 326.44 C 357.75 358.13 331.31 392.7 291.98 403.65 C 252.66 414.6 215.35 397.8 208.65 366.11 C 201.95 334.42 228.39 299.85 267.72 288.89 C 307.04 277.94 344.35 294.75 351.05 326.44"/>
      <path fill="#231816" d="M 242.83 344.37 C 249.68 338.91 251.41 328.11 246.7 320.25 L 246.53 319.96 C 241.83 312.1 232.46 310.15 225.62 315.6 L 75.54 435.27 L 18.86 438.13 C 10.56 437.93 5.72 443.88 5.51 453.45 L 5.5 453.8 C 5.29 463.37 11.85 471.29 20.15 471.49 L 77.97 470.35 C 80.16 470.41 82.25 469.9 84.15 468.98 L 84.93 470.27 Z M 242.83 344.37"/>
      <path fill="#231816" d="M 383.06 591 C 375.97 590.27 370.75 582.94 371.4 574.64 L 372.12 565.47 C 372.06 565.5 372 565.54 371.94 565.57 C 355.38 574.13 335.52 564.14 326.79 543.24 L 326.74 543.26 L 253.13 347.29 L 229.26 359.62 L 303.72 557.86 L 303.79 557.83 C 318.91 593.86 354.71 610.32 385.16 594.59 C 386.84 593.72 388.46 592.75 390.04 591.73 Z M 383.06 591"/>
      <path fill="#ffffff" d="M 513.68 547.53 C 513.68 580.59 487.59 607.4 455.41 607.4 C 423.22 607.4 397.13 580.59 397.13 547.53 C 397.13 514.46 423.22 487.66 455.41 487.66 C 487.59 487.66 513.68 514.46 513.68 547.53"/>
      <g clip-path="url(#dg-ro-clip)">
      <path fill="none" stroke-width="1" stroke="#231816" d="M 513.91 180.6 C 513.91 147.51 487.8 120.69 455.59 120.69 C 423.38 120.69 397.27 147.51 397.27 180.6 C 397.27 213.69 423.38 240.52 455.59 240.52 C 487.8 240.52 513.91 213.69 513.91 180.6 Z M 513.91 180.6" transform="matrix(0.99932, 0, 0, -0.99932, 0.128039, 728.008337)"/>
      </g>
      <path fill="#231816" d="M 426.99 529.68 L 432.71 507.27 L 421.17 499.08 C 413.15 505.07 406.67 513.11 402.47 522.46 L 405.36 530.68 Z M 467.3 560.12 L 472.3 537.53 L 453.8 525.3 L 437.37 540.32 L 445.71 561.84 Z M 430.19 579.52 L 424.51 598.3 C 432.06 603.16 440.77 606.29 450.11 607.15 L 459.05 599.91 L 452.16 578.45 Z M 509.94 526.38 L 496.64 523.14 L 485.62 542.38 L 500.97 559.67 L 513.29 554.53 C 513.55 552.23 513.68 549.9 513.68 547.53 C 513.68 540.08 512.36 532.96 509.94 526.38 M 474.42 564.79 L 463.4 584.03 L 478.75 601.32 L 486.88 597.92 C 491.24 595.05 495.2 591.59 498.65 587.66 L 496.58 570.19 Z M 418.48 542.49 L 397.28 543.3 C 397.18 544.7 397.13 546.11 397.13 547.53 C 397.13 556.57 399.09 565.14 402.58 572.83 L 409.34 577.23 L 426.75 563.43 Z M 489.15 503.34 L 485.3 496.13 C 476.77 490.88 466.83 487.81 456.2 487.67 L 453.08 509.04 L 473.39 519.11 Z M 489.15 503.34"/>
      <path fill="none" stroke-width="1" stroke="#231816" d="M 496.79 157.93 L 501.18 168.45" transform="matrix(0.99932, 0, 0, -0.99932, 0.128039, 728.008337)"/>
      <path fill="none" stroke-width="1" stroke="#231816" d="M 467.1 170.65 L 475.89 159.6" transform="matrix(0.99932, 0, 0, -0.99932, 0.128039, 728.008337)"/>
      <path fill="none" stroke-width="1" stroke="#231816" d="M 445.89 166.28 L 450.49 143.02" transform="matrix(0.99932, 0, 0, -0.99932, 0.128039, 728.008337)"/>
      <path fill="none" stroke-width="1" stroke="#231816" d="M 453.98 202.85 L 455.37 219.29" transform="matrix(0.99932, 0, 0, -0.99932, 0.128039, 728.008337)"/>
      <path fill="none" stroke-width="1" stroke="#231816" d="M 432.87 220.89 L 453.26 219.12" transform="matrix(0.99932, 0, 0, -0.99932, 0.128039, 728.008337)"/>
      <path fill="none" stroke-width="1" stroke="#231816" d="M 472.96 212.66 L 489.58 192.76" transform="matrix(0.99932, 0, 0, -0.99932, 0.128039, 728.008337)"/>
      <path fill="none" stroke-width="1" stroke="#231816" d="M 430.35 148.59 L 416.28 157.39" transform="matrix(0.99932, 0, 0, -0.99932, 0.128039, 728.008337)"/>
      <path fill="none" stroke-width="1" stroke="#231816" d="M 459.24 128.18 L 472.96 136.38" transform="matrix(0.99932, 0, 0, -0.99932, 0.128039, 728.008337)"/>
      <path fill="none" stroke-width="1" stroke="#231816" d="M 416.28 201.34 L 416.28 181.71" transform="matrix(0.99932, 0, 0, -0.99932, 0.128039, 728.008337)"/>
      <path fill="none" stroke-width="1" stroke="#231816" d="M 418.64 185.65 L 440.71 185.02" transform="matrix(0.99932, 0, 0, -0.99932, 0.128039, 728.008337)"/>
      <path fill="none" stroke-width="1" stroke="#231816" d="M 472.49 190.61 L 490.56 183.92" transform="matrix(0.99932, 0, 0, -0.99932, 0.128039, 728.008337)"/>
      <path fill="#231816" d="M 401.26 577.44 C 401.26 586.2 393.46 593.31 383.84 593.31 C 374.21 593.31 366.41 586.2 366.41 577.44 C 366.41 568.67 374.21 561.56 383.84 561.56 C 393.46 561.56 401.26 568.67 401.26 577.44"/>
      </svg>
      <h3>公文公告助手</h3>
      </div>

      <label>Apps Script Web App 網址</label>
      <input id="dg-url" placeholder="https://script.google.com/macros/s/.../exec">
      <label>BRIDGE_TOKEN（沒設定就留空）</label>
      <input id="dg-token">
      <button class="act" id="dg-save">儲存設定</button>

      <label style="margin-top:16px">欄位對應</label>
      <div id="dg-map"></div>
      <label>內文填入目標</label>
      <select id="dg-editor"><option value="">（按下方偵測）</option></select>
      <button class="act" id="dg-detect">偵測編輯器</button>

      <label style="margin-top:16px">待發布公告</label>
      <select id="dg-case"><option value="">（按下方重新整理）</option></select>
      <button class="act" id="dg-refresh">重新整理清單</button>
      <button class="act go" id="dg-fill">帶入這則公告</button>
      <div class="sub" style="margin-top:8px">送出按鈕請自己按，腳本只負責填。</div>

      <label style="margin-top:16px">上架後的公告網址</label>
      <input id="dg-puburl" placeholder="校網公告網址（.../p/....php）">
      <button class="act" id="dg-done">已在校網看到，標記完成</button>
      <div class="sub" style="margin-top:6px">先到校網打開這則公告、複製網址貼上，才會標記完成。</div>

      <label style="margin-top:18px">自動發布（黑快馬 R-page）</label>
      <div class="row" style="border-top:none">
        <label style="display:flex;gap:8px;align-items:center;margin:0;font-size:13px;color:#202124;font-weight:600">
          <input type="checkbox" id="dg-auto" style="width:auto">核准後自動發布
        </label>
      </div>
      <div class="sub">開著後台這個分頁就會每 2 分鐘檢查一次；登入過期或出錯會自動暫停。</div>
      <div class="sub" id="dg-auto-status" style="margin-top:4px;color:#1a5fb4"></div>
      <button class="act" id="dg-dry">試跑：只填表、不送出</button>

      <div id="dgejh-msg"></div>
    </div>`;
  shadow.appendChild(panel);
  document.body.appendChild(host);

  const $ = id => panel.querySelector(id);
  $('#dgejh-fab').onclick = () => panel.classList.toggle('open');
  $('#dg-url').value = cfg.url;
  $('#dg-token').value = cfg.token;

  function msg(text, kind) {
    const m = $('#dgejh-msg');
    m.textContent = text;
    m.className = 'show ' + (kind === 'err' ? 'err' : kind === 'warn' ? 'warn' : 'okm');
    if (!kind) setTimeout(() => m.classList.remove('show'), 5000);   // 錯誤與提醒會留著
  }

  function renderMap() {
    const map = cfg.map;
    $('#dg-map').innerHTML = FIELDS.map(f =>
      `<div class="row"><span style="flex:1">${f.label}</span>` +
      `<span class="${map[f.key] ? 'ok' : 'no'}">${map[f.key] ? '已對應' : '未對應'}</span>` +
      `<button data-k="${f.key}" style="padding:3px 9px;border:1px solid #dadce0;border-radius:5px;background:#fff;cursor:pointer">對應</button></div>`
    ).join('');
    $('#dg-map').querySelectorAll('button').forEach(b => {
      b.onclick = () => pick(b.dataset.k);
    });
  }
  renderMap();

  function pick(key) {
    const f = FIELDS.find(x => x.key === key);
    panel.classList.remove('open');
    broadcast({ type: 'pick-start', field: key, hint: f.hint });
    const onPicked = function (ev) {
      const m = ev.data;
      if (!m || m.__dgejh !== true || m.type !== 'picked' || !sameSite(ev)) return;
      window.removeEventListener('message', onPicked);
      broadcast({ type: 'pick-stop' });   // 其他頁框也要結束點選模式
      panel.classList.add('open');
      if (!m.selector) return;
      const map = cfg.map;
      map[key] = { selector: m.selector, frameId: m.frameId };
      cfg.map = map;
      renderMap();
      msg(f.label + ' 對應完成');
    };
    window.addEventListener('message', onPicked);
  }

  $('#dg-save').onclick = function () {
    cfg.url = $('#dg-url').value.trim();
    cfg.token = $('#dg-token').value.trim();
    msg('設定已儲存');
  };

  $('#dg-detect').onclick = function () {
    const found = [];
    const onEd = function (ev) {
      const m = ev.data;
      if (!m || m.__dgejh !== true || m.type !== 'editors' || !sameSite(ev)) return;
      m.list.forEach(x => found.push(Object.assign({ frameId: m.frameId }, x)));
    };
    window.addEventListener('message', onEd);
    broadcast({ type: 'detect-editors' });
    setTimeout(function () {
      window.removeEventListener('message', onEd);
      // 優先選 CKEditor / TinyMCE，其次可編輯 iframe，textarea 最後
      const rank = x => /^ckeditor|^tinymce/.test(x.key) ? 0 : /^iframe|^ce/.test(x.key) ? 1 : 2;
      found.sort((a, b) => rank(a) - rank(b));
      const sel = $('#dg-editor');
      sel.innerHTML = found.length
        ? found.map((x, i) => `<option value="${i}">${esc(x.label)}</option>`).join('')
        : '<option value="">找不到編輯器</option>';
      sel.onchange = function () {
        cfg.editor = found[Number(sel.value)];
        msg('內文目標已設定');
      };
      if (found.length) { sel.value = '0'; cfg.editor = found[0]; }
      msg('偵測到 ' + found.length + ' 個可填入的編輯器');
    }, 900);
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // 顯示上次選定的內文目標
  (function () {
    const ed = cfg.editor;
    if (ed) $('#dg-editor').innerHTML = `<option value="">${esc(ed.label)}（已設定）</option>`;
  })();

  // 清單：待發布＋送出中（送出中的可以直接貼網址標記完成）
  $('#dg-refresh').onclick = function () {
    Promise.all([api({ api: 'pending' }), api({ api: 'verifying' })]).then(function (rs) {
      const p = rs[0].cases, v = rs[1].cases;
      const opts = p.map(c => `<option value="${esc(c.caseId)}">${esc(c.title)}（附件 ${Number(c.attachments) || 0}）</option>`)
        .concat(v.map(c => `<option value="${esc(c.caseId)}">（送出中）${esc(c.title)}</option>`));
      const sel = $('#dg-case');
      sel.innerHTML = opts.length ? opts.join('') : '<option value="">沒有待發布的公告</option>';
      msg('有 ' + p.length + ' 則待發布' + (v.length ? '、' + v.length + ' 則送出中' : ''));
    }).catch(e => msg(e.message, 'err'));
  };

  /**
   * 手動帶入後，等人按「新增並返回」：視窗關了就去列表找新公告、記下網址。
   * 找不到（多半是按了取消）就記成待人工確認，不自動退回，避免其實已經送出卻又重發。
   */
  let manualWatch = null;   // 同時只追一則：上一則還沒按新增或取消前，不能再帶入別則
  function watchManual(d, before) {
    manualWatch = { title: d.title };
    (async function () {
      const closed = await waitFor(() => !RP.dlgOpen(), 60 * 60 * 1000, 1000);
      manualWatch = null;
      const row = closed ? await waitFor(() => findNewRow(before, d.title), 20000, 500) : null;
      try {
        if (row) {
          const r = await reportSubmitted(d, row, '手動帶入後按新增');
          msg(r.live ? '「' + d.title + '」已上架，已標成已發布。\n' + r.url
                     : '「' + d.title + '」已新增，等校網出現後會自動標成已發布。\n' + r.url);
        } else {
          await api({ api: 'submitted', id: d.caseId, url: '',
                      note: (closed ? '手動帶入後視窗關閉，但列表找不到這則' : '手動帶入後 60 分鐘都沒有按新增或取消') +
                            '；沒有送出的話請在審核台按「後台沒有這則，改回待發布」' });
          msg('「' + d.title + '」' + (closed ? '的視窗關了，但後台列表找不到這則。' : '帶入後 60 分鐘都沒有送出。') + '\n' +
              '如果沒有送出，請到審核台按「後台沒有這則，改回待發布」。', 'warn');
        }
      } catch (e) { msg(e.message, 'err'); }
      $('#dg-refresh').click();
    })();
  }

  $('#dg-fill').onclick = async function () {
    const id = $('#dg-case').value;
    if (!id) return msg('先選一則公告', 'err');
    if (manualWatch) {
      return msg('「' + manualWatch.title + '」還在等你按「新增並返回」或「取消」，處理完再帶入下一則。', 'warn');
    }
    // 黑快馬 R-page 的新增資訊視窗開著：用固定欄位直接填（HTML 模式、公告模組、附件），不需對應
    if (RP.dlgOpen()) {
      try {
        // 先領取（變成送出中）：自動模式就不會再發一次同一則
        const d = (await api({ api: 'claim', id: id })).data;
        let filled = false;
        try {
          const files = await downloadFiles(d);
          // 看得到公告列表才能比對「新出現的那一則」；看不到就不自動記網址（避免抓到同名的舊公告）
          const canWatch = !!RP.list();
          const before = new Set(RP.rows().map(r => r.id));
          await RP.fill(d, files, t => setStatus(t));
          filled = true;
          msg('已帶入「' + d.title + '」（HTML 內文、公告模組、附件 ' + files.length + ' 個）。\n' +
              (canWatch ? '檢查後再按「新增並返回」，按完會自動記下公告網址。'
                        : '檢查後再按「新增並返回」。上架後請在下方貼網址標記完成。'));
          if (canWatch) watchManual(d, before);
        } catch (e) {
          // 還沒填好就失敗：人還沒按新增，退回待發布
          if (!filled) { try { await api({ api: 'fail', id: d.caseId, msg: '手動帶入失敗：' + e.message }); } catch (_) {} }
          throw e;
        }
      } catch (e) { msg(e.message, 'err'); }
      return;
    }
    const map = cfg.map;
    // 先開始收各頁框的回報，再送出指令；下載附件期間回來的回報也不會漏掉
    const results = {};
    const onResult = function (ev) {
      const m = ev.data;
      if (m && m.__dgejh === true && m.type === 'fill-done' && sameSite(ev) && !(m.field in results)) {
        results[m.field] = m.error || null;
      }
    };
    window.addEventListener('message', onResult);
    let claimed = null;
    try {
      // 先領取（變成送出中），自動模式不會再發；送出後請用「已在校網看到，標記完成」
      const r = await api({ api: 'claim', id: id });
      const d = claimed = r.data;
      const expect = [];   // 送出的欄位，等各頁框回報

      const plan = [
        ['title', d.title], ['category', d.category],
        ['startDate', d.startDate], ['endDate', d.endDate]
      ];
      const unmapped = [];
      for (const [key, value] of plan) {
        if (!value) continue;
        if (!map[key]) { unmapped.push(FIELDS.find(f => f.key === key).label); continue; }
        broadcast({ type: 'fill', frameId: map[key].frameId, field: key,
                    value: value, selector: map[key].selector });
        expect.push(key);
      }

      if (cfg.editor) {
        broadcast({ type: 'set-editor', frameId: cfg.editor.frameId,
                    editorKey: cfg.editor.key, html: d.body });
        expect.push('body');
      } else {
        unmapped.push('內文');
      }

      if (map.file && d.attachments.length) {
        msg('下載附件中（共 ' + d.attachments.length + ' 個，含公文本體）…', 'warn');
        const files = [];
        for (const a of d.attachments) {
          const fr = await api({ api: 'file', id: a.id });
          files.push(fr.file);
        }
        broadcast({ type: 'attach', frameId: map.file.frameId,
                    selector: map.file.selector, files: files });
        expect.push('file');
      } else if (d.attachments.length) {
        unmapped.push('附件');
      }

      const bad = await waitResults(results, expect, 6000);
      if (unmapped.length) bad.push('尚未對應：' + unmapped.join('、'));
      const odf = odfMissing(d.attachments.map(a => a.name));
      const odfNote = odf.length
        ? '\n\nODF 規範提醒：下列檔案沒有一併附上 ODF 版本，請補上傳：\n' + odf.join('\n')
        : '';
      if (bad.length) {
        msg('已帶入部分欄位，請檢查：\n' + bad.join('\n') + odfNote, 'err');
      } else if (odf.length) {
        msg('已帶入「' + d.title + '」。' + odfNote, 'warn');
      } else {
        msg('已帶入「' + d.title + '」（附件 ' + d.attachments.length + ' 個）。檢查一遍再按後台的送出。');
      }
    } catch (e) {
      if (claimed) { try { await api({ api: 'fail', id: claimed.caseId, msg: '手動帶入失敗：' + e.message }); } catch (_) {} }
      msg(e.message, 'err');
    } finally {
      window.removeEventListener('message', onResult);
    }
  };

  /** Word/Excel/PowerPoint 檔沒有同名 ODF 檔時列出來（比對時去掉「主題_日期_附件N_」前綴） */
  function odfMissing(names) {
    const PAIR = { doc: 'odt', docx: 'odt', xls: 'ods', xlsx: 'ods', ppt: 'odp', pptx: 'odp' };
    const parse = n => {
      const m = String(n).replace(/^.+_附件\d+(?:_|(?=\.[A-Za-z0-9]{1,8}$)|$)/, '').match(/^(.*)\.([A-Za-z0-9]+)$/);
      return m ? { base: m[1], ext: m[2].toLowerCase() } : { base: n, ext: '' };
    };
    const list = names.map(parse);
    return names.filter(function (n, k) {
      const p = list[k];
      const want = PAIR[p.ext];
      return want && !list.some(q => q.base === p.base && q.ext === want);
    });
  }

  /** 等到預期的欄位都回報（或逾時）；沒回報的代表頁框對不上 */
  async function waitResults(results, keys, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end && keys.some(k => !(k in results))) await new Promise(r => setTimeout(r, 100));
    const errors = [];
    keys.forEach(function (k) {
      if (!(k in results)) errors.push(LABEL[k] + '：找不到對應的頁框，請重新對應');
      else if (results[k]) errors.push(LABEL[k] + '：' + results[k]);
    });
    return errors;
  }

  const LABEL = { title: '公告標題', category: '分類', startDate: '公告起日',
                  endDate: '公告迄日', file: '附件', body: '內文' };

  /**
   * 標記完成一定要有校網上的公告網址。
   * 1.2 以前用瀏覽器的 prompt 視窗，視窗沒跳出來或留空也會標記完成，
   * 結果公告其實沒上架，系統卻記成已發布。
   */
  $('#dg-done').onclick = function () {
    const id = $('#dg-case').value;
    if (!id) return msg('先選一則公告', 'err');
    const url = $('#dg-puburl').value.trim();
    if (!/^https:\/\/www\.dgejh\.ntpc\.edu\.tw\/p\/\d{3}-\d+-\d+/.test(url)) {
      return msg('還沒標記完成。請先到校網打開這則公告，把網址貼到「上架後的公告網址」再按。\n' +
                 '找不到這則公告，代表後台還沒真正上架（可能還在待審核或草稿）。', 'warn');
    }
    api({ api: 'done', id: id, url: url })
      .then(() => { msg('已標記完成'); $('#dg-puburl').value = ''; $('#dg-refresh').click(); })
      .catch(e => msg(e.message, 'err'));
  };

  // ============================================================
  // 自動發布模式（黑快馬 R-page 公告模組）
  // ============================================================

  const SITE = location.origin;   // 校網公開頁與後台同一個網域
  const PAGE = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const CYCLE_MS = 2 * 60 * 1000;
  const vis = e => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  async function waitFor(fn, ms, step) {
    const end = Date.now() + (ms || 10000);
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step || 200); }
    return null;
  }
  function setVal(el, v) {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function setStatus(t) {
    const s = $('#dg-auto-status');
    if (s) s.textContent = new Date().toTimeString().slice(0, 5) + ' ' + t;
  }
  async function downloadFiles(d) {
    const files = [];
    for (const a of (d.attachments || [])) files.push((await api({ api: 'file', id: a.id })).file);
    return files;
  }

  /**
   * 黑快馬 R-page「公告模組 → 新增資訊」（2026-10 實機確認）
   * 注意：彈出視窗的 id（fullDiv10、fullDiv12…）每次開都不同，元件前綴（C10_）也可能變，
   * 所以視窗一律從「資訊名稱」欄位往上找，分頁與列表用 id 結尾比對。
   */
  const RP = {
    loginPage: () => !!document.querySelector('input[name="login_name"]'),
    list: () => {
      const all = [...document.querySelectorAll('[id$="_RightList_ListDiv"]')];
      return all.find(vis) || all[0] || null;
    },
    dlg: () => {
      const n = document.getElementById('TB_pt_name');
      return n ? (n.closest('.pop-module, [id^="fullDiv"]') || n.form || document.body) : null;
    },
    // 以整個視窗是否顯示為準：切到「附件」分頁時資訊名稱欄會被藏起來，不能當成視窗關了
    dlgOpen: () => {
      const n = document.getElementById('TB_pt_name');
      const box = n && n.closest('.pop-module, [id^="fullDiv"]');
      return box ? vis(box) : vis(n);
    },
    /** 視窗開著而且有人填了東西（可能是老師正在手動新增） */
    formBusy: () => {
      if (!RP.dlgOpen()) return false;
      const d = RP.dlg();
      const name = document.getElementById('TB_pt_name').value.trim();
      const body = (d.querySelector('textarea[name="TB_pt_detail"]') || {}).value || '';
      return !!(name || body.trim());
    },

    async ensureModule() {
      if (vis(RP.list())) return true;
      const tab = [...document.querySelectorAll('a,span,li,div')]
        .find(e => vis(e) && e.children.length <= 1 && e.textContent.trim() === '公告模組');
      if (tab) tab.click();
      return !!(await waitFor(() => vis(RP.list()), 8000));
    },

    async openNew() {
      if (RP.formBusy()) throw new Error('「新增資訊」視窗正在使用中（已有內容），請先關掉');
      if (RP.dlgOpen()) {             // 空白的視窗（例如上次中斷留下的）：關掉重開
        RP.closeDialog();
        await waitFor(() => !RP.dlgOpen(), 5000);
      }
      const add = [...RP.list().querySelectorAll('a')].find(a => a.textContent.trim() === '新增' && vis(a));
      if (!add) throw new Error('找不到公告模組的「新增」按鈕');
      add.click();
      if (!await waitFor(RP.dlgOpen, 10000)) throw new Error('「新增資訊」視窗沒有打開');
      await sleep(500);
    },

    async fill(d, files, log) {
      const D = RP.dlg();
      if (!D) throw new Error('找不到「新增資訊」視窗');
      const q = s => D.querySelector(s);
      const need = (s, label) => {
        const e = q(s);
        if (!e) throw new Error('找不到「' + label + '」（' + s + '），後台可能改版');
        return e;
      };
      log = log || function () {};

      // 基本資料
      need('[id$="_sm_basic"]', '基本資料分頁').click(); await sleep(300);
      setVal(need('#TB_pt_name', '資訊名稱'), d.title);
      setVal(need('input[name="TB_pt_rel_date"]', '發佈日期'), d.startDate);
      setVal(need('input[name="TB_pt_expire"]', '下架日期'), d.endDate);
      ['RelDateHour', 'RelDateMin', 'ExpireHour', 'ExpireMin'].forEach(n => {
        const e = q('select[name="' + n + '"]'); if (e) setVal(e, '00');
      });
      need('#pt_acti1', '資訊狀態：有效').click();

      // 詳細說明：一律 HTML 模式（內文已在系統端依 AA 清理）
      need('#pt_FCKeditor2_fckHTML', '詳細說明的 HTML 選項').click(); await sleep(400);
      if (!q('#pt_FCKeditor2_fckHTML').checked) throw new Error('詳細說明沒有切到 HTML 模式');
      setVal(need('textarea[name="TB_pt_detail"]', '詳細說明'), d.body);
      log('已填標題、日期、內文（HTML）');

      // 分類 → 公告 → 選擇所屬公告模組 → 勾選 → 確定
      if (!d.groupIds || !d.groupIds.length) throw new Error('分類「' + d.category + '」沒有對應的公告模組');
      need('[id$="_scg_sm_rcg"]', '分類區的「公告」').click(); await sleep(300);
      const pick = [...D.querySelectorAll('a,input[type="button"],button')]
        .find(e => /選擇所屬公告模組/.test(e.textContent || e.value || ''));
      if (!pick) throw new Error('找不到「選擇所屬公告模組」');
      pick.click(); await sleep(400);
      [...D.querySelectorAll('input[name="ChkRcg[]"]')].forEach(cb => {
        const want = d.groupIds.indexOf(Number(cb.value)) >= 0;
        if (cb.checked !== want) cb.click();
      });
      const box = q('#rcg_' + d.groupIds[0]);
      const inner = box && box.closest('.dropdown-inner');
      const ok = inner && inner.querySelector('input[type="button"][value="確定"]');
      if (ok) ok.click();
      await sleep(400);
      const miss = d.groupIds.filter(id => { const cb = q('#rcg_' + id); return !cb || !cb.checked; });
      if (miss.length) throw new Error('公告模組沒有勾到：' + miss.join('、'));
      log('已勾選公告模組 ' + d.groupIds.join('、'));

      // 附件：一個「上傳附件」欄位一個檔案，不夠就按「上傳更多附件」
      if (files.length) {
        need('[id$="_sm_ptattach"]', '附件分頁').click();
        const first = await waitFor(() => q('input[type="file"][name^="ptaFile"]'), 10000);
        if (!first) throw new Error('附件分頁沒有載入上傳欄位');
        await attachFiles('#' + CSS.escape(first.id), files);
        const placed = [...D.querySelectorAll('input[type="file"][name^="ptaFile"]')]
          .reduce((n, i) => n + i.files.length, 0);
        if (placed !== files.length) throw new Error('附件只放進 ' + placed + '／' + files.length + ' 個');
        log('已放入附件 ' + files.length + ' 個');
        need('[id$="_sm_basic"]', '基本資料分頁').click();
      }
    },

    rows() {
      const L = RP.list();
      return [...(L ? L.querySelectorAll('tr') : [])].map(tr => {
        const cb = tr.querySelector('input[name="Chk[]"]');
        return cb && cb.value ? { id: Number(cb.value), text: tr.textContent.replace(/\s+/g, ' ').trim() } : null;
      }).filter(Boolean);
    },

    /**
     * 按「新增並返回」；把頁面的 alert/confirm 收起來，不讓對話框卡住自動流程。
     * alert 多半是欄位檢查不過（視窗還開著＝確定沒送出）；confirm 是「確定要…」之類，已自動按確定。
     */
    async save() {
      const alerts = [], confirms = [];
      const oa = PAGE.alert, oc = PAGE.confirm;
      PAGE.alert = m => { alerts.push(String(m)); };
      PAGE.confirm = m => { confirms.push(String(m)); return true; };
      try {
        const btn = RP.dlg() && RP.dlg().querySelector('input[name="QuickAdd"]');
        if (!btn) throw new Error('找不到「新增並返回」');
        btn.click();
        const closed = await waitFor(() => !RP.dlgOpen(), PAGE.__dgejhSaveWaitMs || 60000, 500);   // 測試可縮短
        await sleep(800);
        return { closed: !!closed, alerts: alerts, confirms: confirms, msgs: alerts.concat(confirms) };
      } finally {
        PAGE.alert = oa; PAGE.confirm = oc;
      }
    },

    closeDialog() {
      const D = RP.dlg();
      const c = D && [...D.querySelectorAll('input[type="button"]')].find(b => b.value === '取消' && vis(b));
      if (c) c.click();
    }
  };

  function coreTitle(t) { return String(t).replace(/^(【[^】]*】)+/, '').trim().slice(0, 24); }

  /** 列表裡新出現、標題對得上的那一則（編號最大的） */
  function findNewRow(before, title) {
    return RP.rows().filter(x => !before.has(x.id) && x.text.indexOf(coreTitle(title)) >= 0)
      .sort((a, b) => b.id - a.id)[0] || null;
  }

  function pubUrl(row, d) { return SITE + '/p/406-1000-' + row.id + ',r' + d.groupIds[0] + '.php'; }

  /** 已在後台新增：回報網址；校網看得到就直接標成已發布 */
  async function reportSubmitted(d, row, note) {
    const url = pubUrl(row, d);
    await api({ api: 'submitted', id: d.caseId, url: url, note: note || '' });
    if (await visibleOnSite(url, d.title)) {
      await api({ api: 'done', id: d.caseId, url: url });
      return { url: url, live: true };
    }
    return { url: url, live: false };
  }

  /** 校網公開頁面真的看得到這則公告 */
  async function visibleOnSite(url, title) {
    try {
      const r = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      if (!r.ok) return false;
      const html = await r.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return (doc.body ? doc.body.textContent : '').indexOf(coreTitle(title)) >= 0;
    } catch (e) { return false; }
  }

  // 自動模式設定（存在瀏覽器）
  Object.defineProperty(cfg, 'auto', {
    get() { return GM_getValue('auto', '0') === '1'; },
    set(v) { GM_setValue('auto', v ? '1' : '0'); }
  });

  /**
   * 回報狀態給系統（審核台頂端顯示；暫停或登入過期會寄信）。
   * running：自動發布運作中　off：沒勾自動發布　paused：出錯暫停（附原因）　login：後台登入過期
   */
  function beat(state, why) {
    api({ api: 'beat', auto: cfg.auto ? '1' : '0', state: state, msg: why || '' }).catch(() => {});
  }

  function pauseAuto(reason) {
    cfg.auto = false;
    GM_setValue('pausedReason', String(reason).slice(0, 200));
    beat('paused', reason);
    $('#dg-auto').checked = false;
    setStatus('已暫停');
    msg('自動發布已暫停：' + reason + '\n處理好後再勾一次「核准後自動發布」。', 'err');
    panel.classList.add('open');
  }

  /** 處理一則：領取 → 開新增資訊 → 填表 → 新增並返回 → 找到新編號 → 回報 */
  async function publishOne(c0) {
    let d;
    try { d = (await api({ api: 'claim', id: c0.caseId })).data; }
    catch (e) { setStatus('略過「' + c0.title + '」：' + e.message); return; }

    setStatus('發布中：' + d.title);
    let clicked = false;
    try {
      const files = await downloadFiles(d);
      await RP.openNew();
      const before = new Set(RP.rows().map(r => r.id));
      await RP.fill(d, files, t => setStatus(t));
      clicked = true;
      const res = await RP.save();

      if (!res.closed && !findNewRow(before, d.title)) {
        if (res.alerts.length) {
          // 視窗沒關、後台跳出錯誤訊息：欄位檢查沒過，確定沒送出，可以退回待發布
          RP.closeDialog();
          clicked = false;
          throw new Error('後台訊息：' + res.alerts.join(' / '));
        }
        // 視窗沒關、也沒有錯誤訊息：不知道到底送出了沒有（例如附件很大還在上傳）。
        // 不退回待發布（會重發），交給人工到後台確認。
        await api({ api: 'submitted', id: d.caseId, url: '',
                    note: '按了新增並返回但視窗沒有關閉，請到後台確認是否已新增' + (res.msgs.length ? '：' + res.msgs.join(' / ') : '') });
        throw new Error('按了「新增並返回」但視窗沒有關閉，請到後台確認是否已新增，再到審核台處理這則');
      }

      const row = await waitFor(() => findNewRow(before, d.title), 20000, 500);
      if (!row) {
        await api({ api: 'submitted', id: d.caseId, url: '', note: '已按新增，但列表找不到這則，請人工確認。' + res.msgs.join(' / ') });
        throw new Error('已按新增，但後台列表找不到「' + d.title + '」，請人工確認');
      }

      const r = await reportSubmitted(d, row, res.msgs.join(' / '));
      if (r.live) {
        setStatus('已發布：' + d.title);
        msg('已自動發布「' + d.title + '」\n' + r.url);
      } else {
        setStatus('已新增，等校網出現（可能需要後台審核）：' + d.title);
      }
    } catch (e) {
      if (!clicked) {
        try { await api({ api: 'fail', id: d.caseId, msg: e.message }); } catch (_) {}
        RP.closeDialog();
      }
      pauseAuto('「' + d.title + '」' + e.message);
    }
  }

  let busy = false;
  async function cycle() {
    if (busy) return;
    // 同一台電腦開了好幾個後台分頁時，只讓一個分頁做事、回報狀態
    // （先看鎖：停在登入頁的舊分頁、沒勾自動的分頁，不會蓋掉正常分頁回報的狀態）
    const lock = JSON.parse(GM_getValue('autoLock', '{}') || '{}');
    const otherTab = lock.tab && lock.tab !== TAB_ID && Date.now() - lock.at < CYCLE_MS * 1.5;
    if (!cfg.auto) {   // 沒開自動發布：照樣回報，審核台才知道（暫停的話附上原因）
      const why = GM_getValue('pausedReason', '');
      if (!otherTab) beat(why ? 'paused' : 'off', why);
      return;
    }
    if (otherTab) return;
    if (RP.loginPage()) { setStatus('後台登入已過期，請重新登入；登入後會自動繼續'); beat('login', '校網後台登入已過期'); return; }
    GM_setValue('autoLock', JSON.stringify({ tab: TAB_ID, at: Date.now() }));

    busy = true;
    // 這一輪結束時回報的狀態：沒辦法送出（不在公告模組頁、新增視窗開著、檢查失敗）回報 stuck，
    // 審核台才會在核准的公告等太久時寄信
    let state = 'running', why = '';
    try {
      // 1. 已送出、等校網出現的
      const v = await api({ api: 'verifying' });
      for (const c of v.cases) {
        if (c.url && await visibleOnSite(c.url, c.title)) {
          await api({ api: 'done', id: c.caseId, url: c.url });
          msg('已確認上架「' + c.title + '」');
        }
      }
      // 2. 新的待發布（一次一則）
      const p = await api({ api: 'pending' });
      if (!p.cases.length) { setStatus('沒有待發布的公告（' + v.cases.length + ' 則等校網出現）'); return; }
      if (!await RP.ensureModule()) {
        setStatus('請打開「公告模組」頁面'); state = 'stuck'; why = '後台分頁不在「公告模組」頁'; return;
      }
      if (RP.formBusy()) {
        setStatus('「新增資訊」視窗有人在用，等關掉後下一輪再發'); state = 'stuck'; why = '後台的「新增資訊」視窗開著、裡面有內容'; return;
      }
      await publishOne(p.cases[0]);
    } catch (e) {
      setStatus('檢查失敗：' + e.message);
      state = 'stuck'; why = '檢查失敗：' + e.message;
    } finally {
      busy = false;
      if (cfg.auto) beat(state, why);   // 暫停的話 pauseAuto 已經回報過
    }
  }

  const TAB_ID = Math.random().toString(36).slice(2, 10);
  $('#dg-auto').checked = cfg.auto;
  $('#dg-auto').onchange = function () {
    cfg.auto = this.checked;
    GM_setValue('pausedReason', '');   // 人自己勾或取消：清掉上次暫停的原因
    if (this.checked) {
      msg('自動發布已開啟：核准的公告會由這個分頁自動送出。這個分頁請保持開著、不要登出。', 'warn');
      setTimeout(cycle, 1000);
    } else {
      setStatus('已關閉');
    }
  };
  setInterval(cycle, CYCLE_MS);
  if (cfg.auto) setTimeout(cycle, 5000);
  // 保持後台登入（只在自動模式開著時）
  setInterval(function () {
    if (cfg.auto && !RP.loginPage()) fetch(location.pathname, { credentials: 'same-origin', cache: 'no-store' }).catch(() => {});
  }, 10 * 60 * 1000);
  window.__dgejhAutoCycle = cycle;   // 測試用

  // 試跑：用目前選的待發布公告填一次表，不按新增、不改狀態
  $('#dg-dry').onclick = async function () {
    const id = $('#dg-case').value;
    if (!id) return msg('先按「重新整理清單」選一則公告', 'err');
    try {
      if (!await RP.ensureModule()) throw new Error('請先打開「公告模組」');
      const d = (await api({ api: 'case', id: id })).data;
      const files = await downloadFiles(d);
      await RP.openNew();
      await RP.fill(d, files, t => setStatus('試跑：' + t));
      setStatus('試跑完成');
      msg('試跑完成：表單已填好，沒有送出。請檢查「基本資料」「附件」分頁與勾選的公告模組，看完按「取消」關閉。', 'warn');
    } catch (e) {
      msg('試跑失敗：' + e.message, 'err');
    }
  };

})();
