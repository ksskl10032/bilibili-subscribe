// ==UserScript==
// @name         哔哩哔哩 · 关注回顾 (Followings Review)
// @name:zh-CN   哔哩哔哩 · 关注回顾
// @namespace    bilibili-followings-review
// @version      1.1.1
// @description  一键回顾你关注的全部 UP 主：概括内容类型、最后一条视频与最火视频、关注时间与年度关注史，支持图表统计与批量取关，帮你想起当初为什么关注。
// @description:zh-CN  回顾关注的全部 UP 主：类型概括、最后更新/最火视频、饼图统计、年度关注史、批量取关。
// @author       you
// @license      MIT
// @match        *://*.bilibili.com/*
// @match        *://bilibili.com/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @connect      api.bilibili.com
// @connect      app.biliapi.com
// @connect      api.deepseek.com
// @connect      api.openai.com
// @connect      api.anthropic.com
// @connect      api.moonshot.cn
// @connect      dashscope.aliyuncs.com
// @connect      open.bigmodel.cn
// @connect      api.siliconflow.cn
// @connect      api.minimax.chat
// @connect      api.x.ai
// @noframes
// ==/UserScript==

/**
 * ============================================================================
 * 哔哩哔哩 · 关注回顾  v1.1.1
 * ----------------------------------------------------------------------------
 * 功能：
 *   1. 拉取【当前登录账号】关注的全部用户（关注时间 mtime / 是否互关 attribute）。
 *   2. 对每个 UP 主请求最近投稿（x/space/wbi/arc/search）：
 *      - 最后一条视频的发布时间 / 标题 / 分区；
 *      - 最近若干条视频标题 + 全站分区统计(tlist)；
 *      - 最火视频（order=click 再取一次，或从已取回的列表中直接算）。
 *   3. 本地规则概括「TA 是什么类型的 UP 主」；可选大模型（DeepSeek 等）概括。
 *   4. 报告面板：搜索/筛选/排序、两个饼图（最后更新时间占比、类型占比）、
 *      按关注年份的类型分布（回想“我在 2025 年主要关注了什么”）。
 *   5. 区分「无投稿」与「账号已注销」（后者用 acc/info 探测）。
 *   6. 批量取关：勾选后逐条调用 x/relation/modify(act=2) 取关。
 *   7. 导出 JSON / Markdown。
 *
 * 接口资料：
 *   关注列表  GET  api.bilibili.com/x/relation/followings     (含 mtime/attribute)
 *   投稿明细  GET  api.bilibili.com/x/space/wbi/arc/search     (WBI 签名)
 *   空间信息  GET  api.bilibili.com/x/space/wbi/acc/info       (WBI 签名，判定注销)
 *   兜底(APP) GET  app.biliapi.com/x/v2/space/archive/cursor
 *   取关      POST api.bilibili.com/x/relation/modify          (act=2, csrf)
 *
 * 隐私说明：启用「大模型概括」时，会把【UP主昵称/认证/签名/视频标题】发送到你
 *   填写的模型服务商。默认本地规则分析不上传任何内容。
 * 风险提示：批量取关会真实修改你的 B 站关注关系，且不可撤销。
 * ============================================================================
 */

(function () {
  'use strict';

  // 同一页面只允许一份实例运行：防止重复安装脚本导致重复采集、重复按钮与重复通知
  try {
    if (document.documentElement.getAttribute('data-bfr-loaded') === '1') return;
    document.documentElement.setAttribute('data-bfr-loaded', '1');
  } catch (e) { /* ignore */ }

  const VERSION = '1.1.1';
  const STORE_KEY = 'bfr_store_v1';      // 关注数据缓存
  const SETTINGS_KEY = 'bfr_settings_v1';
  const WBICACHE_KEY = 'bfr_wbi_v1';

  const DAY = 86400000;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  const DEF_SETTINGS = {
    llmEnabled: false,
    llmBase: 'https://api.deepseek.com',
    llmKey: '',
    llmModel: 'deepseek-chat',
    llmBatch: 10,
    concurrency: 3,
    pageGap: 320,          // 拉取单个 UP 主时的最小间隔(ms)
    recentN: 12,           // 每个 UP 主缓存多少条最近视频
    ttlHours: 6,           // 缓存有效期（小时内自动跳过）
    notifyOnDone: true,
    fetchTop: true,        // 是否采集“最火视频”
    unfollowGap: 900       // 批量取关的间隔(ms)
  };

  /* ============================== 基础工具 ============================== */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function nowTs() { return Date.now(); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDate(tsSec) {
    if (!tsSec) return '—';
    const d = new Date(tsSec * 1000);
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function fmtYm(tsSec) {
    if (!tsSec) return '—';
    const d = new Date(tsSec * 1000);
    return d.getFullYear() + '-' + (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1);
  }

  function daysAgo(tsSec) {
    if (!tsSec) return null;
    return Math.floor((Date.now() - tsSec * 1000) / DAY);
  }

  function fmtSpan(days) {
    if (days == null) return '';
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 30) return days + ' 天前';
    if (days < 365) {
      const m = Math.floor(days / 30);
      return m + ' 个月前';
    }
    const y = Math.floor(days / 365);
    return y + ' 年前';
  }

  function fmtPlay(n) {
    if (!n && n !== 0) return '';
    if (n >= 100000000) return (n / 100000000).toFixed(1) + ' 亿';
    if (n >= 10000) return (n / 10000).toFixed(1) + ' 万';
    return String(n);
  }

  function trunc(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function median(arr) {
    if (!arr || !arr.length) return null;
    const a = arr.slice().sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /* MD5（纯 JS，用于 wbi 签名） */
  /*MD5-START*/
  function md5(inputString) {
    function safeAdd(x, y) {
      var lsw = (x & 0xffff) + (y & 0xffff);
      return (((x >> 16) + (y >> 16) + (lsw >> 16)) << 16) | (lsw & 0xffff);
    }
    function bitRotateLeft(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
    function md5cmn(q, a, b, x, s, t) {
      return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
    }
    function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | (~b & d), a, b, x, s, t); }
    function md5gg(a, b, c, d, x, s, t) { return md5cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
    function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | ~d), a, b, x, s, t); }
    function binlMD5(x, len) {
      x[len >> 5] |= 0x80 << (len % 32);
      x[(((len + 64) >>> 9) << 4) + 14] = len;
      var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
      for (var i = 0; i < x.length; i += 16) {
        var olda = a, oldb = b, oldc = c, oldd = d;
        a = md5ff(a, b, c, d, x[i], 7, -680876936);
        d = md5ff(d, a, b, c, x[i + 1], 12, -389564586);
        c = md5ff(c, d, a, b, x[i + 2], 17, 606105819);
        b = md5ff(b, c, d, a, x[i + 3], 22, -1044525330);
        a = md5ff(a, b, c, d, x[i + 4], 7, -176418897);
        d = md5ff(d, a, b, c, x[i + 5], 12, 1200080426);
        c = md5ff(c, d, a, b, x[i + 6], 17, -1473231341);
        b = md5ff(b, c, d, a, x[i + 7], 22, -45705983);
        a = md5ff(a, b, c, d, x[i + 8], 7, 1770035416);
        d = md5ff(d, a, b, c, x[i + 9], 12, -1958414417);
        c = md5ff(c, d, a, b, x[i + 10], 17, -42063);
        b = md5ff(b, c, d, a, x[i + 11], 22, -1990404162);
        a = md5ff(a, b, c, d, x[i + 12], 7, 1804603682);
        d = md5ff(d, a, b, c, x[i + 13], 12, -40341101);
        c = md5ff(c, d, a, b, x[i + 14], 17, -1502002290);
        b = md5ff(b, c, d, a, x[i + 15], 22, 1236535329);
        a = md5gg(a, b, c, d, x[i + 1], 5, -165796510);
        d = md5gg(d, a, b, c, x[i + 6], 9, -1069501632);
        c = md5gg(c, d, a, b, x[i + 11], 14, 643717713);
        b = md5gg(b, c, d, a, x[i], 20, -373897302);
        a = md5gg(a, b, c, d, x[i + 5], 5, -701558691);
        d = md5gg(d, a, b, c, x[i + 10], 9, 38016083);
        c = md5gg(c, d, a, b, x[i + 15], 14, -660478335);
        b = md5gg(b, c, d, a, x[i + 4], 20, -405537848);
        a = md5gg(a, b, c, d, x[i + 9], 5, 568446438);
        d = md5gg(d, a, b, c, x[i + 14], 9, -1019803690);
        c = md5gg(c, d, a, b, x[i + 3], 14, -187363961);
        b = md5gg(b, c, d, a, x[i + 8], 20, 1163531501);
        a = md5gg(a, b, c, d, x[i + 13], 5, -1444681467);
        d = md5gg(d, a, b, c, x[i + 2], 9, -51403784);
        c = md5gg(c, d, a, b, x[i + 7], 14, 1735328473);
        b = md5gg(b, c, d, a, x[i + 12], 20, -1926607734);
        a = md5hh(a, b, c, d, x[i + 5], 4, -378558);
        d = md5hh(d, a, b, c, x[i + 8], 11, -2022574463);
        c = md5hh(c, d, a, b, x[i + 11], 16, 1839030562);
        b = md5hh(b, c, d, a, x[i + 14], 23, -35309556);
        a = md5hh(a, b, c, d, x[i + 1], 4, -1530992060);
        d = md5hh(d, a, b, c, x[i + 4], 11, 1272893353);
        c = md5hh(c, d, a, b, x[i + 7], 16, -155497632);
        b = md5hh(b, c, d, a, x[i + 10], 23, -1094730640);
        a = md5hh(a, b, c, d, x[i + 13], 4, 681279174);
        d = md5hh(d, a, b, c, x[i], 11, -358537222);
        c = md5hh(c, d, a, b, x[i + 3], 16, -722521979);
        b = md5hh(b, c, d, a, x[i + 6], 23, 76029189);
        a = md5hh(a, b, c, d, x[i + 9], 4, -640364487);
        d = md5hh(d, a, b, c, x[i + 12], 11, -421815835);
        c = md5hh(c, d, a, b, x[i + 15], 16, 530742520);
        b = md5hh(b, c, d, a, x[i + 2], 23, -995338651);
        a = md5ii(a, b, c, d, x[i], 6, -198630844);
        d = md5ii(d, a, b, c, x[i + 7], 10, 1126891415);
        c = md5ii(c, d, a, b, x[i + 14], 15, -1416354905);
        b = md5ii(b, c, d, a, x[i + 5], 21, -57434055);
        a = md5ii(a, b, c, d, x[i + 12], 6, 1700485571);
        d = md5ii(d, a, b, c, x[i + 3], 10, -1894986606);
        c = md5ii(c, d, a, b, x[i + 10], 15, -1051523);
        b = md5ii(b, c, d, a, x[i + 1], 21, -2054922799);
        a = md5ii(a, b, c, d, x[i + 8], 6, 1873313359);
        d = md5ii(d, a, b, c, x[i + 15], 10, -30611744);
        c = md5ii(c, d, a, b, x[i + 6], 15, -1560198380);
        b = md5ii(b, c, d, a, x[i + 13], 21, 1309151649);
        a = md5ii(a, b, c, d, x[i + 4], 6, -145523070);
        d = md5ii(d, a, b, c, x[i + 11], 10, -1120210379);
        c = md5ii(c, d, a, b, x[i + 2], 15, 718787259);
        b = md5ii(b, c, d, a, x[i + 9], 21, -343485551);
        a = safeAdd(a, olda); b = safeAdd(b, oldb); c = safeAdd(c, oldc); d = safeAdd(d, oldd);
      }
      return [a, b, c, d];
    }
    function binl2rstr(input) {
      var i, output = '';
      var length32 = input.length * 32;
      for (i = 0; i < length32; i += 8) {
        output += String.fromCharCode((input[i >> 5] >>> (i % 32)) & 0xff);
      }
      return output;
    }
    function rstr2binl(input) {
      var i, output = [];
      output[(input.length >> 2) - 1] = undefined;
      for (i = 0; i < output.length; i += 1) { output[i] = 0; }
      var length8 = input.length * 8;
      for (i = 0; i < length8; i += 8) {
        output[i >> 5] |= (input.charCodeAt(i / 8) & 0xff) << (i % 32);
      }
      return output;
    }
    function rstrMD5(s) {
      return binl2rstr(binlMD5(rstr2binl(s), s.length * 8));
    }
    function rstr2hex(input) {
      var hexTab = '0123456789abcdef';
      var output = '';
      var x, i;
      for (i = 0; i < input.length; i += 1) {
        x = input.charCodeAt(i);
        output += hexTab.charAt((x >>> 4) & 0x0f) + hexTab.charAt(x & 0x0f);
      }
      return output;
    }
    function str2rstrUTF8(input) {
      return unescape(encodeURIComponent(input));
    }
    return rstr2hex(rstrMD5(str2rstrUTF8(inputString)));
  }
  /*MD5-END*/

  /* ============================== WBI 签名 ============================== */

  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52
  ];

  function getMixinKey(orig) {
    return MIXIN_KEY_ENC_TAB.map(function (n) { return orig[n]; }).join('').slice(0, 32);
  }

  /** 为参数生成 wbi 签名，返回可直接拼到 URL 的完整 query 字符串 */
  function encWbi(params, imgKey, subKey) {
    const mixinKey = getMixinKey(imgKey + subKey);
    const wts = Math.round(Date.now() / 1000);
    const p = {};
    Object.keys(params).forEach(function (k) { p[k] = params[k]; });
    p.wts = wts;
    const query = Object.keys(p).sort().map(function (k) {
      const v = String(p[k]).replace(/[!'()*]/g, '');
      return encodeURIComponent(k) + '=' + encodeURIComponent(v);
    }).join('&');
    return query + '&w_rid=' + md5(query + mixinKey);
  }

  /* ============================== 网络请求 ============================== */

  function gmx(opts) {
    return new Promise(function (resolve, reject) {
      try {
        GM_xmlhttpRequest({
          method: opts.method || 'GET',
          url: opts.url,
          headers: opts.headers || {},
          data: opts.data || undefined,
          timeout: opts.timeout || 25000,
          onload: function (res) {
            resolve({ status: res.status, text: res.responseText });
          },
          onerror: function () { reject(new Error('NETWORK')); },
          ontimeout: function () { reject(new Error('TIMEOUT')); },
          onabort: function () { reject(new Error('ABORT')); }
        });
      } catch (e) { reject(e); }
    });
  }

  const apiHeaders = {
    'User-Agent': UA,
    'Referer': (typeof location !== 'undefined' && location.href) ? location.href : 'https://www.bilibili.com/'
  };

  function biliCookieHeader() {
    try { return document.cookie || ''; } catch (e) { return ''; }
  }

  function getCsrf() {
    try {
      const m = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }

  function parseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  /** 请求 B 站 api（GET），返回 {ok, httpStatus, code, message, data, raw} */
  async function biliGet(url, params, opt) {
    opt = opt || {};
    let qs = '';
    if (params) {
      qs = Object.keys(params).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
      }).join('&');
    }
    const full = url + (url.indexOf('?') >= 0 ? '&' : '?') + qs;
    const headers = Object.assign({}, apiHeaders);
    if (opt.cookie !== false) headers['Cookie'] = biliCookieHeader();
    const res = await gmx({ url: full, headers: headers });
    const j = parseJson(res.text);
    const out = {
      ok: false, httpStatus: res.status,
      code: (j && j.code != null) ? j.code : null,
      message: j ? j.message : '', data: j ? j.data : null, raw: res.text
    };
    if (j && j.code === 0) out.ok = true;
    return out;
  }

  /** 请求 B 站 api（POST form），返回同上 */
  async function biliPost(url, params) {
    const body = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    const headers = Object.assign({}, apiHeaders, {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': biliCookieHeader()
    });
    const res = await gmx({ method: 'POST', url: url, headers: headers, data: body });
    const j = parseJson(res.text);
    const out = {
      ok: false, httpStatus: res.status,
      code: (j && j.code != null) ? j.code : null,
      message: j ? j.message : '', data: j ? j.data : null, raw: res.text
    };
    if (j && j.code === 0) out.ok = true;
    return out;
  }

  /* ---------- wbi keys ---------- */
  async function getWbiKeys(force) {
    let cache = null;
    try { cache = JSON.parse(GM_getValue(WBICACHE_KEY, 'null')); } catch (e) { cache = null; }
    if (!force && cache && cache.img_key && cache.sub_key && (nowTs() - cache.t) < 12 * 3600 * 1000) {
      return cache;
    }
    const nav = await biliGet('https://api.bilibili.com/x/web-interface/nav', null, { cookie: true });
    if (!nav.ok || !nav.data || !nav.data.wbi_img) {
      throw new Error('NAV_FAIL:' + (nav.message || nav.httpStatus));
    }
    const take = function (u) {
      return (u || '').slice(u.lastIndexOf('/') + 1).split('.')[0] || '';
    };
    const k = {
      img_key: take(nav.data.wbi_img.img_url),
      sub_key: take(nav.data.wbi_img.sub_url),
      t: nowTs()
    };
    if (!k.img_key || !k.sub_key) throw new Error('NAV_NO_KEY');
    GM_setValue(WBICACHE_KEY, JSON.stringify(k));
    return k;
  }

  async function buildSignedUrl(endpoint, params, forceKeys) {
    const keys = await getWbiKeys(forceKeys);
    const qs = encWbi(params, keys.img_key, keys.sub_key);
    return endpoint + '?' + qs;
  }

  /* ============================== 存储 ============================== */

  function loadSettings() {
    let s = null;
    try { s = JSON.parse(GM_getValue(SETTINGS_KEY, 'null')); } catch (e) { s = null; }
    return Object.assign({}, DEF_SETTINGS, s || {});
  }
  function saveSettings(s) {
    GM_setValue(SETTINGS_KEY, JSON.stringify(s));
  }
  function loadStore() {
    let st = null;
    try { st = JSON.parse(GM_getValue(STORE_KEY, 'null')); } catch (e) { st = null; }
    if (!st || !st.items || !st.order) {
      return { version: VERSION, savedAt: 0, account: null, order: [], items: {}, llmRanAt: 0 };
    }
    Object.keys(st.items).forEach(function (mid) {
      const it = st.items[mid];
      if (it.status === 'noarchive') it.status = 'novideo';
      if (it.attr == null) it.attr = 0;
      if (it.followTs == null) it.followTs = 0;
      if (it.top === undefined) it.top = null;
    });
    return st;
  }
  function saveStore() {
    try { GM_setValue(STORE_KEY, JSON.stringify(STORE)); } catch (e) { /* 存储超限时静默 */ }
  }

  /* ============================== 运行时状态 ============================== */
  let SETTINGS = loadSettings();
  let STORE = loadStore();
  let UI = null;
  let scanState = null;   // {running, cancelled, kind}
  const view = {
    mode: 'list',        // list | charts
    tab: 'all',
    search: '',
    sort: 'recent',
    minPlay: 0,          // 最火视频播放量阈值筛选
    catFilter: null,     // 类型（大类）筛选
    yearFilter: null,    // 关注年份筛选
    manage: false,       // 管理模式（显示勾选框）
    selected: {}         // mid -> true
  };
  const PALETTE = ['#fb7299', '#00a1d6', '#ffb400', '#4cc38a', '#9b6bff', '#ff7f50', '#20c4c4', '#c9c9c9', '#8fa3bf', '#e07a9a'];

  /* ============================== 分区/类型推断 ============================== */

  const TID_NAME = {
    1: '动画', 2: '番剧', 3: '国创', 4: '音乐', 5: '舞蹈', 6: '游戏',
    7: '知识', 8: '科技', 9: '运动', 10: '汽车', 11: '生活', 12: '美食',
    13: '动物圈', 14: '鬼畜', 15: '时尚', 16: '资讯', 17: '娱乐', 18: '影视',
    19: '纪录片', 20: '电影', 21: '电视剧', 22: '直播', 24: '课堂',
    27: '单机游戏', 28: '手机游戏', 29: '网络游戏', 30: '音游',
    32: 'VOCALOID·UTAU', 35: '翻唱', 36: '原创音乐', 37: '演奏', 38: '音乐现场',
    39: '音乐综合', 41: 'MV', 43: '宅舞', 44: '街舞', 46: '中国舞', 47: '舞蹈综合',
    48: '鬼畜调教', 49: '音MAD', 51: '短片·手书·配音', 52: '特摄',
    54: '搞笑', 60: '日常', 61: '户外', 70: '篮球', 71: '足球', 72: '健身',
    75: 'MAD·AMV', 76: 'MMD·3D', 79: 'ASMR', 81: '绘画', 82: '日常',
    83: '亲子', 84: '出行', 85: '三农', 86: '家居房产', 87: '美食制作',
    88: '美食侦探', 89: '美食测评', 90: '田园美食', 91: '美食记录',
    92: '科学科普', 93: '社科·法律·心理', 94: '人文历史', 95: '财经商业',
    96: '校园学习', 97: '职业职场', 98: '设计·创意', 99: '野生技能协会',
    100: '数码', 101: '软件应用', 102: '计算机技术', 103: '科工机械', 104: '极客DIY',
    105: '热点', 106: '环球', 107: '社会', 108: '综合资讯', 109: '综艺',
    110: '明星综合', 111: '娱乐圈', 112: '影视杂谈', 113: '影视剪辑', 114: '短片',
    115: '预告·资讯', 116: '人文·历史', 117: '科学·探索·自然', 118: '军事',
    119: '社会·美食·旅行', 120: '国产动画', 124: '美妆护肤', 125: '穿搭',
    126: '时尚潮流', 127: '汉服', 128: '仿妆cos', 138: '游戏赛事', 234: '健身'
  };

  function majorOfName(name) {
    if (!name) return null;
    const n = String(name);
    const has = function (s) { return n.indexOf(s) >= 0; };
    if (has('游戏') || has('电竞')) return '游戏';
    if (has('虚拟主播') || has('Vtuber') || has('vUP')) return '虚拟主播';
    if (has('音乐') || has('VOCALOID') || has('翻唱') || has('演奏') || has('乐评') || has('电音')) return '音乐';
    if (has('舞蹈')) return '舞蹈';
    if (has('鬼畜') || has('音MAD') || has('人力VOCAL')) return '鬼畜';
    if (has('动画') || has('MAD') || has('MMD') || has('手书') || has('配音') || has('特摄')) return '动画·番剧';
    if (has('番剧') || has('国创') || has('布袋戏') || has('动态漫')) return '动画·番剧';
    if (has('知识') || has('科普') || has('财经') || has('校园') || has('职场') || has('社科')
      || has('人文') || has('历史') || has('法律') || has('心理') || has('设计') || has('职业')) return '知识';
    if (has('科技') || has('数码') || has('软件') || has('计算机') || has('极客') || has('装机')
      || has('科工') || has('手机') || has('电脑') || has('平板') || has('DIY')) return '科技数码';
    if (has('汽车') || has('摩托') || has('赛车') || has('改装') || has('新能源车') || has('房车')
      || has('购车')) return '汽车';
    if (has('运动') || has('篮球') || has('足球') || has('健身') || has('竞技体育') || has('骑行')
      || has('乒乓球') || has('羽毛球') || has('搏击')) return '运动健身';
    if (has('军事') || has('军武') || has('枪械')) return '军事';
    if (has('美食') || has('吃货') || has('料理') || has('探店') || has('烹饪') || has('烘焙')) return '美食';
    if (has('动物') || has('宠物') || has('喵') || has('汪') || has('爬宠') || has('水族')
      || has('鸟') || has('猫') || has('狗')) return '动物';
    if (has('时尚') || has('美妆') || has('护肤') || has('穿搭') || has('汉服') || has('仿妆')
      || has('彩妆') || has('发型') || has('服饰')) return '时尚';
    if (has('影视') || has('电影') || has('电视剧') || has('剪辑') || has('解说') || has('影评')
      || has('预告')) return '影视';
    if (has('娱乐') || has('综艺') || has('明星') || has('娱乐圈')) return '娱乐';
    if (has('纪录片')) return '纪录片';
    if (has('资讯') || has('热点') || has('新闻') || has('环球') || has('社会')) return '资讯';
    if (has('搞笑')) return '搞笑';
    if (has('生活') || has('日常') || has('vlog') || has('Vlog') || has('亲子') || has('出行')
      || has('三农') || has('家居') || has('手工') || has('绘画') || has('户外')) return '生活';
    return null;
  }

  const SIGN_RULES = [
    ['游戏', '游戏'], ['电竞', '游戏'], ['音乐', '音乐'], ['唱歌', '音乐'], ['唱见', '音乐'],
    ['舞蹈', '舞蹈'], ['美食', '美食'], ['做饭', '美食'], ['吃饭', '美食'],
    ['科技', '科技数码'], ['数码', '科技数码'], ['编程', '科技数码'], ['代码', '科技数码'],
    ['程序', '科技数码'], ['程序员', '科技数码'], ['开发', '科技数码'],
    ['考研', '知识'], ['英语', '知识'], ['知识', '知识'], ['科普', '知识'], ['读书', '知识'],
    ['历史', '知识'], ['学习', '知识'],
    ['影视', '影视'], ['电影', '影视'], ['剪辑', '影视'],
    ['健身', '运动健身'], ['运动', '运动健身'], ['篮球', '运动健身'],
    ['美妆', '时尚'], ['穿搭', '时尚'], ['时尚', '时尚'],
    ['绘画', '绘画创作'], ['画画', '绘画创作'], ['画师', '绘画创作'], ['插画', '绘画创作'],
    ['手工', '生活'], ['日常', '生活'], ['vlog', '生活'], ['Vlog', '生活'], ['生活', '生活'],
    ['动画', '动画·番剧'], ['漫画', '动画·番剧'],
    ['宠物', '动物'], ['猫', '动物'], ['狗', '动物'], ['铲屎官', '动物'],
    ['汽车', '汽车'], ['车评', '汽车'],
    ['搞笑', '搞笑'], ['沙雕', '搞笑'], ['整活', '搞笑']
  ];

  /** 本地规则概括 */
  function categorizeLocal(up) {
    const officialDesc = (up.official && up.official.desc) || '';
    const officialType = (up.official && up.official.type) || -1;
    const sign = (up.sign || '').trim();
    const zones = up.zones || [];
    const tags = [];

    let major = null;
    let zoneName = '';
    let source = '';

    if (up.status === 'deleted') {
      return {
        major: '已注销', label: '账号已注销/不可访问',
        detail: '该账号在 B 站已不存在（接口返回 -404），大概率是注销或被永久封禁。',
        tags: [], source: 'probe'
      };
    }

    if (officialDesc) {
      const isOrg = officialType === 1 || /官方/.test(officialDesc);
      if (isOrg) {
        major = '官方/机构';
        source = 'official';
      } else {
        const m = officialDesc.match(/(?:知名|认证)?([\u4e00-\u9fa5A-Za-z·]{1,8})(?:UP主|创作者)/);
        const hint = m ? m[1] : '';
        const byName = hint ? majorOfName(hint) : null;
        if (byName) {
          major = byName;
          source = 'official';
        } else {
          major = 'UP主认证';
          source = 'official';
        }
      }
    }

    if (!major && zones.length) {
      const top = zones[0];
      if (top && top.count > 0) {
        zoneName = top.name || (TID_NAME[top.tid] || '');
        const m = majorOfName(zoneName) || (TID_NAME[top.tid] ? majorOfName(TID_NAME[top.tid]) : null);
        if (m) { major = m; source = 'zone'; }
      }
    }

    if (!major && sign) {
      for (let i = 0; i < SIGN_RULES.length; i++) {
        if (sign.indexOf(SIGN_RULES[i][0]) >= 0) {
          major = SIGN_RULES[i][1];
          source = 'sign';
          break;
        }
      }
    }

    zones.slice(0, 2).forEach(function (z) {
      const nm = z.name || TID_NAME[z.tid] || '';
      if (nm && tags.indexOf(nm) < 0) tags.push(nm);
    });

    const detail = [];
    if (source === 'official') detail.push('认证：' + officialDesc);
    if (zoneName) detail.push('投稿以「' + zoneName + '」为主');
    if (zones.length >= 2 && zones[1] && zones[1].count > 0) {
      const nm2 = zones[1].name || TID_NAME[zones[1].tid] || '';
      if (nm2 && nm2 !== zoneName && zones[1].count / (zones[0].count || 1) >= 0.25) {
        detail.push('兼有「' + nm2 + '」');
      }
    }
    if (!officialDesc && sign) detail.push('签名：' + trunc(sign, 60));
    if (!officialDesc && !zones.length && !sign) {
      detail.push(up.status === 'novideo' ? '该账号暂无公开投稿（可能只在直播/专栏活动，也可能是你的好友）'
        : '暂无可判断依据');
    }

    return {
      major: major || '未知',
      label: major || '未知',
      detail: detail.join('；'),
      tags: tags.slice(0, 4),
      source: source || 'none'
    };
  }

  function cadenceOf(recent) {
    if (!recent || recent.length < 2) return null;
    const ts = recent.map(function (v) { return v.created; }).sort(function (a, b) { return a - b; });
    const gaps = [];
    for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 86400);
    return Math.round(median(gaps));
  }

  /* ============================== B 站数据接口 ============================== */

  async function fetchFollowingsAll(onProgress) {
    const list = [];
    const ps = 50;
    let pn = 1;
    let total = -1;
    while (true) {
      const r = await biliGet('https://api.bilibili.com/x/relation/followings', {
        vmid: STORE.account.mid, pn: pn, ps: ps
      }, { cookie: true });
      if (r.code === -101 || r.code === -400) {
        const e = new Error('关注列表请求失败(code=' + r.code + ')：' + r.message + '。请确认已登录 bilibili.com');
        e.kind = 'auth';
        throw e;
      }
      if (!r.ok) {
        throw new Error('关注列表请求失败：code=' + r.code + ' msg=' + r.message);
      }
      const d = r.data || {};
      const pageList = d.list || [];
      pageList.forEach(function (it) { if (it && it.mid) list.push(it); });
      if (d.total != null && d.total > 0) total = d.total;
      if (onProgress) onProgress(list.length, total > 0 ? total : null);
      if (pageList.length < ps || (total > 0 && list.length >= total)) break;
      pn += 1;
      if (pn > 500) break;
      await sleep(180);
    }
    return list;
  }

  function randB64(n) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let s = '';
    for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function parseArchive(d, mid) {
    const listObj = d.list || {};
    const vlist = listObj.vlist || [];
    const tlistRaw = listObj.tlist || {};
    const page = d.page || {};
    const items = vlist.map(function (v) {
      const zName = (tlistRaw[v.typeid] && tlistRaw[v.typeid].name) || TID_NAME[v.typeid] || '';
      return {
        bvid: v.bvid || '', title: v.title || '',
        created: v.created || 0, tid: v.typeid || 0,
        play: v.play || 0, zoneName: zName,
        isLive: !!v.is_live_playback
      };
    });
    const zones = Object.keys(tlistRaw).map(function (tid) {
      return { tid: Number(tid), name: tlistRaw[tid].name || '', count: tlistRaw[tid].count || 0 };
    }).sort(function (a, b) { return b.count - a.count; });

    if (!items.length) {
      return { status: 'noarchive', mid: mid, total: page.count || 0, list: [], zones: zones };
    }
    return { status: 'ok', mid: mid, total: page.count || items.length, list: items, zones: zones };
  }

  async function fetchArchive(mid, order, ps, cfg) {
    const params = { mid: mid, ps: ps, pn: 1, tid: 0, keyword: '', order: order };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const p = Object.assign({}, params);
        if (attempt === 1) {
          p.dm_img_list = '[]';
          p.dm_img_str = randB64(48);
          p.dm_cover_img_str = randB64(48);
          p.dm_img_inter = '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}';
        }
        const url = await buildSignedUrl('https://api.bilibili.com/x/space/wbi/arc/search', p, attempt === 1);
        const r = await biliGet(url, null, { cookie: true });
        if (r.ok && r.data && !r.data.v_voucher) return parseArchive(r.data, mid);
        if (r.ok && (!r.data || r.data.v_voucher)) { await sleep(900); continue; }
        if (r.code === -352 || r.code === -412) { await sleep(1500); continue; }
        if (r.code === -404 || r.code === -400) {
          return { status: 'noarchive', mid: mid, err: '账号不存在或无投稿(code ' + r.code + ')' };
        }
        return { status: 'error', mid: mid, err: 'code=' + r.code + ' ' + r.message };
      } catch (e) {
        const m = String(e.message);
        if (m.indexOf('NAV') === 0 || m === 'NETWORK' || m === 'TIMEOUT') { await sleep(800); continue; }
        return { status: 'error', mid: mid, err: m };
      }
    }

    try {
      const url = 'https://app.biliapi.com/x/v2/space/archive/cursor?vmid=' + mid +
        '&order=' + encodeURIComponent(order || 'pubdate') + '&ps=' + ps;
      const res = await gmx({
        url: url,
        headers: Object.assign({}, apiHeaders, { 'Referer': 'https://www.bilibili.com/' })
      });
      const j = parseJson(res.text);
      if (j && j.code === 0 && j.data) {
        const d = j.data;
        const items = (d.item || []).map(function (it) {
          return {
            bvid: it.bvid || '', title: it.title || '',
            created: it.ctime || 0, tid: 0, play: it.play || 0,
            zoneName: it.tname || ''
          };
        });
        const zones = {};
        items.forEach(function (it) {
          if (it.zoneName) zones[it.zoneName] = (zones[it.zoneName] || 0) + 1;
        });
        const zoneArr = Object.keys(zones).map(function (nm) {
          return { tid: 0, name: nm, count: zones[nm] };
        }).sort(function (a, b) { return b.count - a.count; });
        return {
          status: items.length ? 'ok' : 'noarchive',
          mid: mid, total: d.count || 0, list: items, zones: zoneArr, fromApp: true
        };
      }
      return { status: 'error', mid: mid, err: '兜底接口失败 code=' + (j ? j.code : res.status) };
    } catch (e2) {
      return { status: 'error', mid: mid, err: 'both:' + String(e2.message) };
    }
  }

  /** 探测账号是否仍然存在（区分「无投稿」与「已注销」） */
  async function probeAccount(mid) {
    try {
      const url = await buildSignedUrl('https://api.bilibili.com/x/space/wbi/acc/info',
        { mid: mid, platform: 'web' }, false);
      const r = await biliGet(url, null, { cookie: true });
      if (r.ok && r.data) {
        return {
          alive: true, name: r.data.name || '',
          sign: r.data.sign || '',
          official: r.data.official
            ? { type: r.data.official.type, desc: r.data.official.title || r.data.official.desc || '' }
            : null
        };
      }
      if (r.code === -404 || r.code === -400 || r.code === 40061 || r.code === 22013) return { alive: false };
    } catch (e) { /* 尝试兜底 */ }

    try {
      const r2 = await biliGet('https://api.bilibili.com/x/web-interface/card',
        { mid: mid, photo: false }, { cookie: true });
      if (r2.ok && r2.data && r2.data.card) {
        const c = r2.data.card;
        return {
          alive: true, name: c.name || '', sign: c.sign || '',
          official: c.official_verify ? { type: c.official_verify.type, desc: c.official_verify.desc || '' } : null
        };
      }
      if (r2.code === -404 || r2.code === -400 || r2.code === 40061) return { alive: false };
    } catch (e2) { /* ignore */ }

    return { alive: null };
  }

  async function fetchTopVideo(mid) {
    const r = await fetchArchive(mid, 'click', 1, SETTINGS);
    if (r.status !== 'ok' || !r.list || !r.list.length) return null;
    const v = r.list[0];
    return { bvid: v.bvid, title: trunc(v.title, 120), created: v.created, play: v.play, zone: v.zoneName || '' };
  }

  /* ============================== 批量取关 ============================== */

  async function unfollowOne(mid) {
    const csrf = getCsrf();
    if (!csrf) throw new Error('未找到 csrf（cookie 中缺少 bili_jct），请刷新页面并确认已登录');
    return biliPost('https://api.bilibili.com/x/relation/modify', {
      fid: mid, act: 2, re_src: 11, csrf: csrf
    });
  }

  async function runBatchUnfollow(mids) {
    if (scanState && scanState.running) return;
    const csrf = getCsrf();
    if (!csrf) { showToast('未找到 csrf（bili_jct），请刷新页面并确认已登录。'); return; }
    const list = mids.filter(function (mid) { return STORE.items[mid]; });
    if (!list.length) { showToast('请先勾选要取关的 UP 主。'); return; }

    const preview = list.slice(0, 8).map(function (mid) { return STORE.items[mid].uname; }).join('、');
    const ok = confirm(
      '即将取关 ' + list.length + ' 位 UP 主：\n' + preview + (list.length > 8 ? ' 等' : '') +
      '\n\n⚠ 这会真实取消你在 B 站的关注关系，且无法一键恢复。\n确定要继续吗？'
    );
    if (!ok) return;

    scanState = { running: true, cancelled: false, kind: 'unfollow' };
    setProgress(0, '准备取关…');
    let success = 0, failed = 0;
    const failures = [];
    try {
      for (let i = 0; i < list.length; i++) {
        if (scanState.cancelled) break;
        const mid = list[i];
        const it = STORE.items[mid];
        setProgress(i / list.length, '取关 ' + (i + 1) + '/' + list.length + '：' + (it ? it.uname : mid));
        let r = null;
        try {
          r = await unfollowOne(mid);
        } catch (e) {
          r = { ok: false, code: null, message: String(e.message) };
        }
        if (r && r.ok) {
          success++;
          delete STORE.items[mid];
          delete view.selected[mid];
          STORE.order = STORE.order.filter(function (m) { return String(m) !== String(mid); });
        } else {
          failed++;
          const msg = (r && r.message) ? r.message : '未知错误';
          const code = r ? r.code : null;
          failures.push({ mid: mid, uname: it ? it.uname : '', msg: msg, code: code });
          if (it) it.err = '取关失败：' + msg + (code != null ? '（code ' + code + '）' : '');
          if (code === -111) {
            showToast('csrf 校验失败，已中止。请刷新页面后重试。');
            break;
          }
          if (code === 22013 && it) {
            it.status = 'deleted';
            it.cat = categorizeLocal(it);
          }
        }
        saveStore();
        if (i % 5 === 0) renderStats();
        await sleep(Math.max(300, SETTINGS.unfollowGap || 900));
      }
      saveStore();
      renderAll();
      if (failures.length) {
        const lines = failures.slice(0, 6).map(function (f) {
          return '· ' + f.uname + '：' + f.msg + (f.code != null ? '（' + f.code + '）' : '');
        }).join('\n');
        alert('取关完成：成功 ' + success + '，失败 ' + failed + '。\n\n失败明细（最多显示 6 条）：\n' + lines);
      } else {
        showToast('已取关 ' + success + ' 位 UP 主。');
      }
    } catch (e) {
      showToast('取关过程出错：' + e.message);
      console.error('[关注回顾][取关]', e);
    } finally {
      scanState.running = false;
      hideProgress();
    }
  }

  /* ============================== 扫描流程 ============================== */

  async function runScan(mode) {
    if (scanState && scanState.running) return;
    // 先把状态置为运行中：下面的登录检查含 await，若此时再次触发会并发跑两次并各发一条通知
    scanState = { running: true, cancelled: false, kind: 'scan', notified: false };
    setProgress(0, '正在准备…');
    const cfg = SETTINGS;

    if (!STORE.account || !STORE.account.mid) {
      const nav = await biliGet('https://api.bilibili.com/x/web-interface/nav', null, { cookie: true });
      if (!nav.ok || !nav.data || !nav.data.isLogin) {
        showToast('未检测到登录。请先在 bilibili.com 登录后再使用本脚本。');
        return;
      }
      STORE.account = { mid: nav.data.mid, uname: nav.data.uname || '', face: nav.data.face || '' };
      saveStore();
    }

    try {
      // ---------- 阶段 1/2：关注列表（按真实人数推进） ----------
      const follows = await fetchFollowingsAll(function (done, total) {
        if (scanState.cancelled) throw new Error('CANCELLED');
        const ratio = total ? Math.min(done / total, 1) : 0.02;
        setProgress(ratio * 0.06, '阶段 1/2 · 拉取关注列表 ' + done + (total ? ' / ' + total : '') + ' 人');
      });
      if (scanState.cancelled) return;
      if (!follows.length) { showToast('关注列表为空。'); return; }

      const midSet = {};
      follows.forEach(function (f) {
        midSet[f.mid] = true;
        const followTs = (f.mtime && f.mtime > 0) ? f.mtime : 0;
        const attr = f.attribute != null ? f.attribute : 0;
        if (!STORE.items[f.mid]) {
          STORE.items[f.mid] = {
            mid: f.mid, uname: f.uname || '', face: f.face || '',
            sign: f.sign || '',
            official: {
              type: (f.official_verify && f.official_verify.type) || -1,
              desc: (f.official_verify && f.official_verify.desc) || ''
            },
            attr: attr, followTs: followTs,
            status: 'pending', fetchedAt: 0, err: '',
            total: 0, zones: [], last: null, recent: [], top: null,
            cat: null, llm: null, mediaGapDays: null
          };
        } else {
          const it = STORE.items[f.mid];
          it.uname = f.uname || it.uname;
          it.face = f.face || it.face;
          if (f.sign != null) it.sign = f.sign;
          if (f.official_verify) it.official = { type: f.official_verify.type, desc: f.official_verify.desc };
          it.attr = attr;
          if (followTs) it.followTs = followTs;
        }
      });
      Object.keys(STORE.items).forEach(function (mid) {
        if (!midSet[mid]) delete STORE.items[mid];
      });
      STORE.order = follows.map(function (f) { return f.mid; });
      saveStore();

      // ---------- 阶段 2/2：逐 UP 采集 ----------
      const now = nowTs();
      const ttlMs = cfg.ttlHours * 3600 * 1000;
      const mids = STORE.order.filter(function (mid) {
        const it = STORE.items[mid];
        if (!it) return false;
        if (mode === 'all') return true;
        if (it.status === 'ok' || it.status === 'novideo' || it.status === 'deleted') {
          if (mode === 'stale') return (now - (it.fetchedAt || 0)) > ttlMs;
          return false;
        }
        return true;
      });

      if (!mids.length) {
        hideProgress();
        showToast('无需更新（数据仍在缓存有效期内）。可再点「更新数据」选择全量重扫。');
        return;
      }

      const ps = Math.max(12, (cfg.recentN || 12) + 3);
      let doneCount = 0;
      let idx = 0;

      const worker = async function () {
        while (idx < mids.length && !(scanState && scanState.cancelled)) {
          const mid = mids[idx++];
          await sleep(Math.floor(Math.random() * (cfg.pageGap || 300)));
          const it = STORE.items[mid];
          let res;
          try {
            res = await fetchArchive(mid, 'pubdate', ps, cfg);
          } catch (e) {
            res = { status: 'error', mid: mid, err: String(e.message) };
          }
          if (scanState && scanState.cancelled) return;

          if (res.status === 'ok') {
            const recent = (res.list || []).slice(0, cfg.recentN || 12);
            it.last = recent.length ? {
              bvid: recent[0].bvid, title: trunc(recent[0].title, 120),
              created: recent[0].created, play: recent[0].play,
              zone: recent[0].zoneName || '', tid: recent[0].tid
            } : null;
            it.recent = recent.map(function (v) {
              return {
                bvid: v.bvid, title: trunc(v.title, 120), created: v.created,
                play: v.play, zone: v.zoneName || '', tid: v.tid
              };
            });
            it.total = res.total || recent.length;
            it.zones = (res.zones || []).map(function (z) {
              return { tid: z.tid, name: z.name, count: z.count };
            });
            it.status = 'ok';
            it.err = '';

            if (cfg.fetchTop) {
              if (it.total > 0 && recent.length >= it.total) {
                let best = recent[0];
                recent.forEach(function (v) { if ((v.play || 0) > (best.play || 0)) best = v; });
                it.top = {
                  bvid: best.bvid, title: trunc(best.title, 120),
                  created: best.created, play: best.play, zone: best.zoneName || ''
                };
              } else {
                it.top = await fetchTopVideo(mid);
              }
            } else {
              it.top = null;
            }
            it.cat = categorizeLocal(it);
            it.mediaGapDays = cadenceOf(recent);
          } else {
            // 无投稿 / 采集失败：探测账号是否还存在 → 区分「无投稿」「已注销」
            const probe = await probeAccount(mid);
            if (probe.alive === false) {
              it.status = 'deleted';
              it.err = '账号已注销/不存在';
              it.total = 0; it.last = null; it.recent = []; it.top = null; it.zones = [];
            } else if (probe.alive === true) {
              it.status = 'novideo';
              it.err = '';
              it.total = 0; it.last = null; it.recent = []; it.top = null; it.zones = [];
              if (!it.sign && probe.sign) it.sign = probe.sign;
              if ((!it.official || !it.official.desc) && probe.official) it.official = probe.official;
            } else {
              it.err = res.err || '采集失败（账号状态未知）';
              if (!it.last && !it.total && it.status !== 'deleted') it.status = 'error';
            }
            it.cat = categorizeLocal(it);
            it.mediaGapDays = null;
          }
          it.fetchedAt = nowTs();
          doneCount++;
          if (doneCount % 3 === 0 || doneCount === mids.length) {
            saveStore();
            setProgress(0.06 + 0.94 * (doneCount / mids.length),
              '阶段 2/2 · 采集 UP 主 ' + doneCount + ' / ' + mids.length + '（含最火视频）');
          }
        }
      };

      const concurrency = Math.min(Math.max(1, cfg.concurrency || 3), 6);
      const workers = [];
      for (let w = 0; w < concurrency; w++) workers.push(worker());
      await Promise.all(workers);
      if (scanState && scanState.cancelled) return;

      STORE.savedAt = nowTs();
      saveStore();
      renderAll();
      notifyScanDone(STORE.order.length + ' 位 UP 主已扫描完毕');
      showToast('数据更新完成：共 ' + STORE.order.length + ' 位关注');
    } catch (e) {
      if (e.message !== 'CANCELLED') {
        showToast('出错了：' + e.message);
        console.error('[关注回顾]', e);
      }
    } finally {
      scanState.running = false;
      hideProgress();
    }
  }

  /* ============================== 大模型概括 ============================== */

  async function llmChat(settings, messages) {
    let base = (settings.llmBase || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('未填写 API 地址');
    if (!/\/chat\/completions$/.test(base)) base += '/chat/completions';
    const payload = { model: settings.llmModel, temperature: 0.2, messages: messages };
    const res = await gmx({
      method: 'POST',
      url: base,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (settings.llmKey || '').trim()
      },
      data: JSON.stringify(payload),
      timeout: 90000
    });
    const j = parseJson(res.text);
    if (res.status !== 200 || !j) {
      throw new Error('LLM 请求失败 HTTP ' + res.status + '：' + trunc(res.text, 200));
    }
    if (j.error) throw new Error('LLM 错误：' + (j.error.message || JSON.stringify(j.error)));
    const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!content) throw new Error('LLM 未返回内容');
    return content;
  }

  function extractJsonArray(text) {
    const t = String(text).trim();
    const noFence = t.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '');
    const s = noFence.indexOf('[');
    const e = noFence.lastIndexOf(']');
    if (s < 0 || e <= s) return null;
    try { return JSON.parse(noFence.slice(s, e + 1)); } catch (err) { return null; }
  }

  async function llmSummarizeOneBatch(batch, settings) {
    const brief = batch.map(function (b) {
      const titles = (b.recent || []).slice(0, 10).map(function (v) { return v.title; });
      const zoneStr = (b.zones || []).slice(0, 3)
        .map(function (z) { return z.name + '×' + z.count; }).join('、');
      return {
        i: b._i,
        uname: b.uname,
        official: (b.official && b.official.desc) || '',
        sign: b.sign || '',
        total: b.total || 0,
        lastDays: b.last ? daysAgo(b.last.created) : null,
        zones: zoneStr,
        topVideo: b.top ? (b.top.title + '（' + fmtPlay(b.top.play) + ' 播放）') : '',
        recentTitles: titles
      };
    });
    const system = '你是 B 站 UP 主观察助手。用户关注了很多 UP 主却记不清当初为什么关注，需要你帮 TA 快速回忆。' +
      '请根据每个 UP 主的认证、签名、投稿分区、最火视频与最近视频标题，判断其「内容类型」，并用一句话点出其风格特色/关注价值。' +
      '要求：使用简体中文；只输出一个 JSON 数组，每个元素形如 {"i":序号,"type":"一句话类型，如：游戏区UP主·单机攻略向","why":"一句话风格或关注理由提示"}；' +
      '不要输出 JSON 以外的任何文字、注释或 Markdown 围栏。';
    const userMsg = '以下是要分析的 UP 主（JSON 数组，保持原顺序，i 为序号）：\n' + JSON.stringify(brief);
    const content = await llmChat(settings, [
      { role: 'system', content: system },
      { role: 'user', content: userMsg }
    ]);
    const arr = extractJsonArray(content);
    if (!Array.isArray(arr)) {
      const retry = await llmChat(settings, [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
        { role: 'assistant', content: content },
        { role: 'user', content: '刚才的输出不是合法 JSON 数组。请只输出 JSON 数组，不要任何多余文字。' }
      ]);
      const arr2 = extractJsonArray(retry);
      if (!Array.isArray(arr2)) throw new Error('无法解析 LLM 输出为 JSON 数组');
      return arr2;
    }
    return arr;
  }

  async function runLlmAll() {
    if (!SETTINGS.llmKey || !SETTINGS.llmModel) {
      showToast('请先在设置中填写大模型 API Key 与模型。');
      openSettings();
      return;
    }
    if (!STORE.account || !STORE.order.length) {
      showToast('还没有数据，请先「更新数据」扫描关注。');
      return;
    }
    const mids = STORE.order.filter(function (mid) {
      const it = STORE.items[mid];
      return it && it.status === 'ok';
    });
    if (!mids.length) { showToast('没有可概括的数据（请先更新数据）。'); return; }

    scanState = { running: true, cancelled: false, kind: 'llm' };
    setProgress(0, 'AI 概括中…');
    const batchSize = Math.max(1, SETTINGS.llmBatch || 10);
    let done = 0, fail = 0;
    try {
      for (let i = 0; i < mids.length; i += batchSize) {
        if (scanState.cancelled) break;
        const chunk = mids.slice(i, i + batchSize).map(function (mid) {
          return Object.assign({ _i: mid }, STORE.items[mid]);
        });
        setProgress(i / mids.length, 'AI 概括中：' + Math.min(i + batchSize, mids.length) + ' / ' + mids.length);
        let out = null;
        try {
          out = await llmSummarizeOneBatch(chunk, SETTINGS);
        } catch (e) {
          fail += chunk.length;
          console.error('[关注回顾][LLM]', e);
        }
        if (out && Array.isArray(out)) {
          const byIndex = {};
          out.forEach(function (o) { if (o && o.i != null) byIndex[o.i] = o; });
          chunk.forEach(function (it) {
            const o = byIndex[it._i];
            if (o && (o.type || o.why)) {
              STORE.items[it._i].llm = {
                type: o.type || '', why: o.why || '',
                at: nowTs(), model: SETTINGS.llmModel
              };
            }
          });
          done += chunk.length;
        }
        if (i + batchSize < mids.length) await sleep(150);
        saveStore();
        renderAll();
      }
      STORE.llmRanAt = nowTs();
      saveStore();
      showToast('AI 概括完成：成功 ' + done + '，失败 ' + fail + '（失败项仍显示本地规则结果）');
    } catch (e) {
      showToast('AI 概括中断：' + e.message);
    } finally {
      scanState.running = false;
      hideProgress();
    }
  }

  /* ============================== 派生统计 ============================== */

  function bucketOf(it) {
    if (!it) return 'none';
    if (it.status === 'deleted') return 'deleted';
    if (it.status === 'novideo' || it.status === 'noarchive') return 'novideo';
    if (it.status !== 'ok' || !it.last) return 'none';
    const d = daysAgo(it.last.created);
    if (d == null) return 'none';
    if (d <= 30) return 'recent';
    if (d <= 180) return 'medium';
    if (d <= 365) return 'long';
    return 'dead';
  }

  const BUCKET_LABEL = {
    recent: '近30天更新', medium: '1~6个月前', long: '6~12个月前',
    dead: '停更超1年', novideo: '无投稿', deleted: '账号已注销', none: '待采集/失败'
  };

  function stats() {
    const s = {
      total: STORE.order.length, ok: 0, recent: 0, medium: 0, long: 0, dead: 0,
      novideo: 0, deleted: 0, none: 0, ai: 0, mutual: 0
    };
    STORE.order.forEach(function (mid) {
      const it = STORE.items[mid];
      if (!it) return;
      const b = bucketOf(it);
      s[b] = (s[b] || 0) + 1;
      if (b !== 'none' && b !== 'deleted') s.ok++;
      if (it.attr === 6) s.mutual++;
      if (it.llm && it.llm.type) s.ai++;
    });
    return s;
  }

  function typeCounts() {
    const map = {};
    STORE.order.forEach(function (mid) {
      const it = STORE.items[mid];
      if (!it || it.status === 'deleted') return;
      const major = (it.cat && it.cat.major) || '未知';
      map[major] = (map[major] || 0) + 1;
    });
    return Object.keys(map).map(function (k) { return { label: k, value: map[k] }; })
      .sort(function (a, b) { return b.value - a.value; });
  }

  function timeCounts() {
    const order = ['recent', 'medium', 'long', 'dead', 'novideo', 'deleted', 'none'];
    const map = {};
    STORE.order.forEach(function (mid) {
      const it = STORE.items[mid];
      if (!it) return;
      const b = bucketOf(it);
      map[b] = (map[b] || 0) + 1;
    });
    return order.filter(function (k) { return map[k]; })
      .map(function (k) { return { key: k, label: BUCKET_LABEL[k], value: map[k] }; });
  }

  function yearStats() {
    const years = {};
    let unknown = 0;
    STORE.order.forEach(function (mid) {
      const it = STORE.items[mid];
      if (!it) return;
      const ts = it.followTs;
      if (!ts) { unknown++; return; }
      const y = new Date(ts * 1000).getFullYear();
      if (!years[y]) years[y] = { year: y, count: 0, majors: {} };
      years[y].count++;
      const major = (it.cat && it.cat.major) || '未知';
      years[y].majors[major] = (years[y].majors[major] || 0) + 1;
    });
    const arr = Object.keys(years).map(function (y) {
      const o = years[y];
      o.majors = Object.keys(o.majors).map(function (k) { return { label: k, value: o.majors[k] }; })
        .sort(function (a, b) { return b.value - a.value; });
      return o;
    }).sort(function (a, b) { return b.year - a.year; });
    return { years: arr, unknown: unknown };
  }

  /* ============================== UI ============================== */

  function cssText() {
    return `
.bfr-fab{position:fixed;right:22px;bottom:84px;z-index:2147483000;height:42px;padding:0 16px;border-radius:22px;
 border:none;background:linear-gradient(135deg,#fb7299,#f25d8e);color:#fff;font:600 14px/42px "PingFang SC","Microsoft YaHei",sans-serif;
 box-shadow:0 4px 14px rgba(251,114,153,.45);cursor:pointer;user-select:none}
.bfr-fab:hover{filter:brightness(1.08)}
.bfr-root{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(1200px,97vw);height:min(88vh,880px);z-index:2147483100;
 background:#fff;color:#18191c;border-radius:14px;box-shadow:0 12px 48px rgba(0,0,0,.35);display:none;flex-direction:column;overflow:hidden;
 font:14px/1.6 "PingFang SC","Microsoft YaHei",sans-serif}
.bfr-root.open{display:flex}
.bfr-head{background:linear-gradient(120deg,#fb7299,#fc939f);color:#fff;padding:12px 18px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.bfr-head h1{font-size:16px;margin:0;font-weight:600;white-space:nowrap}
.bfr-head .sub{font-size:12px;opacity:.92;white-space:nowrap}
.bfr-head .sp{flex:1}
.bfr-btn{border:1px solid rgba(255,255,255,.75);background:rgba(255,255,255,.16);color:#fff;border-radius:8px;padding:4px 12px;font-size:12px;cursor:pointer;white-space:nowrap}
.bfr-btn:hover{background:rgba(255,255,255,.28)}
.bfr-btn.primary{background:#fff;color:#fb7299;border-color:#fff;font-weight:600}
.bfr-btn.dark{border-color:#ddd;color:#61666d;background:#fff}
.bfr-btn.danger{border-color:#ff7a45;color:#fff;background:#ff7a45}
.bfr-btn.danger:hover{background:#ff5c1a}
.bfr-btn:disabled{opacity:.5;cursor:not-allowed}
.bfr-progress{display:none;gap:10px;align-items:center;padding:7px 18px;background:#fff3f6;font-size:12.5px;color:#d0507a}
.bfr-progress.on{display:flex}
.bfr-progress span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:62%}
.bfr-bar{flex:1;height:6px;background:#ffe0e9;border-radius:3px;overflow:hidden;min-width:60px}
.bfr-bar i{display:block;height:100%;width:0;background:#fb7299;transition:width .25s ease}
.bfr-toolbar{display:flex;gap:8px;align-items:center;padding:8px 14px;border-bottom:1px solid #eee;flex-wrap:wrap;background:#fafafa}
.bfr-tab{border:none;background:none;padding:4px 10px;border-radius:14px;font-size:13px;color:#61666d;cursor:pointer}
.bfr-tab.on{background:#fb7299;color:#fff}
.bfr-search{flex:1;min-width:150px;border:1px solid #ddd;border-radius:16px;padding:5px 14px;font-size:13px;outline:none}
.bfr-search:focus{border-color:#fb7299}
.bfr-select{border:1px solid #ddd;border-radius:8px;padding:4px 6px;font-size:12px;background:#fff;color:#50555b}
.bfr-stats{display:flex;gap:8px;flex-wrap:wrap;padding:7px 14px;font-size:12px;color:#61666d;border-bottom:1px solid #f0f0f0;align-items:center}
.bfr-chip{padding:1px 10px;border-radius:10px;background:#f1f2f3}
.bfr-chip b{color:#18191c}
.bfr-chip.filter{background:#ffe9f1;color:#d0507a}
.bfr-chip.filter .x{cursor:pointer;margin-left:4px;font-weight:700}
.bfr-list{flex:1;overflow:auto;background:#fff}
.bfr-row{display:grid;grid-template-columns:190px minmax(150px,1fr) minmax(200px,1.1fr) 104px 92px 84px;gap:10px;padding:10px 14px;border-bottom:1px solid #f4f4f4;align-items:center}
.bfr-row.with-sel{grid-template-columns:28px 176px minmax(140px,1fr) minmax(190px,1.05fr) 100px 88px 80px}
.bfr-row:hover{background:#fafbfc}
.bfr-row.sel-on{background:#fff7fa}
.bfr-user{display:flex;gap:9px;align-items:center;min-width:0}
.bfr-user img{width:38px;height:38px;border-radius:50%;background:#eee;flex:none}
.bfr-user .uinfo{min-width:0}
.bfr-user .nm{font-weight:600;color:#18191c;text-decoration:none;font-size:13px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bfr-user .nm:hover{color:#fb7299}
.bfr-user .off{font-size:11px;color:#fb7299;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bfr-user .off.none{color:#b9bdc2}
.bfr-mutual{display:inline-block;font-size:10px;padding:0 5px;border-radius:7px;background:#e8f1ff;color:#3370ff;margin-left:4px;line-height:15px}
.bfr-type .tl{font-weight:600;font-size:13px;color:#333;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.bfr-type .dt{font-size:11.5px;color:#8a9099;margin-top:2px;line-height:1.45;max-height:4.3em;overflow:hidden}
.bfr-ai{background:#eaf6ff;color:#00a1d6;font-size:10px;padding:0 6px;border-radius:8px;line-height:16px;white-space:nowrap}
.bfr-last{min-width:0}
.bfr-last .vt{font-size:12.5px;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;text-decoration:none}
.bfr-last .vt:hover{color:#fb7299}
.bfr-last .zn{font-size:11px;color:#00a1d6}
.bfr-last .hot{font-size:11.5px;color:#8a9099;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;margin-top:3px;text-decoration:none}
.bfr-last .hot:hover{color:#fb7299}
.bfr-last .hot.big{color:#d68000;font-weight:600}
.bfr-last .hot.mega{color:#e23d3d;font-weight:700}
.bfr-time{font-size:12px;color:#61666d}
.bfr-badge{display:inline-block;padding:0 7px;border-radius:9px;font-size:11px;line-height:18px;white-space:nowrap}
.b-recent{background:#e6f7ec;color:#00a54f}
.b-medium{background:#e8f1ff;color:#3370ff}
.b-long{background:#fff4e0;color:#d68000}
.b-dead{background:#ffe9e9;color:#e23d3d}
.b-novideo{background:#f1f2f3;color:#767a80}
.b-deleted{background:#3b3b3b;color:#fff}
.b-none{background:#f1f2f3;color:#9499a0}
.bfr-empty{padding:60px 20px;text-align:center;color:#9499a0}
.bfr-empty .big{font-size:40px;margin-bottom:10px}
.bfr-more{padding:14px;text-align:center;color:#9499a0;font-size:12px}
.bfr-managebar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:7px 14px;background:#fff7fa;border-bottom:1px solid #ffe0e9;font-size:12.5px;color:#d0507a}
.bfr-charts{padding:16px;display:flex;flex-wrap:wrap;gap:16px;align-content:flex-start}
.bfr-card{border:1px solid #eee;border-radius:12px;padding:14px 16px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.03);flex:1 1 380px;min-width:320px}
.bfr-card.wide{flex:1 1 100%}
.bfr-card h3{margin:0 0 10px;font-size:14px;color:#333;font-weight:600}
.bfr-pie{display:flex;gap:14px;align-items:center;flex-wrap:wrap}
.bfr-legend{flex:1;min-width:150px}
.bfr-lg{display:flex;align-items:center;gap:7px;font-size:12.5px;padding:2px 0;cursor:pointer;border-radius:6px}
.bfr-lg:hover{background:#faf7f9}
.bfr-lg .dot{width:10px;height:10px;border-radius:3px;flex:none}
.bfr-lg .lb{flex:1;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bfr-lg .vl{color:#8a9099;font-variant-numeric:tabular-nums}
.bfr-year{display:grid;grid-template-columns:64px 84px 1fr;gap:10px;align-items:center;padding:7px 0;border-bottom:1px dashed #f0f0f0;font-size:12.5px}
.bfr-year .yr{font-weight:700;color:#18191c;font-size:14px}
.bfr-year .ct{color:#8a9099}
.bfr-year .sbar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:#f4f4f4;margin:4px 0}
.bfr-year .sbar i{display:block;height:100%}
.bfr-year .chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
.bfr-year .chips span{background:#f6f7f8;color:#61666d;border-radius:8px;padding:0 7px;font-size:11px}
.bfr-year .act{color:#fb7299;cursor:pointer;text-decoration:none;font-size:12px}
.bfr-year .act:hover{text-decoration:underline}
.bfr-summary{font-size:13px;color:#333;margin-bottom:10px;line-height:1.7}
.bfr-summary b{color:#fb7299}
.bfr-mask{position:fixed;left:0;right:0;top:0;bottom:0;background:rgba(0,0,0,.4);z-index:2147483050;display:none}
.bfr-mask.open{display:block}
.bfr-toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);background:rgba(24,25,28,.92);color:#fff;padding:8px 18px;border-radius:20px;
 font-size:13px;z-index:2147483200;max-width:80vw;box-shadow:0 4px 16px rgba(0,0,0,.3)}
.bfr-modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(500px,94vw);z-index:2147483150;background:#fff;border-radius:12px;
 box-shadow:0 12px 48px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;max-height:88vh}
.bfr-modal.open{display:flex}
.bfr-modal h2{margin:0;font-size:15px;padding:14px 18px;background:#fafbfc;border-bottom:1px solid #eee;flex:none}
.bfr-modal .bd{padding:12px 18px;overflow:auto;flex:1}
.bfr-modal label{display:block;font-size:12.5px;color:#61666d;margin:10px 0 4px}
.bfr-modal label.small{font-size:12.5px;color:#18191c;cursor:pointer}
.bfr-modal input[type=text],.bfr-modal input[type=password],.bfr-modal input[type=number],.bfr-modal select{
 width:100%;box-sizing:border-box;border:1px solid #ddd;border-radius:8px;padding:6px 10px;font-size:13px}
.bfr-modal input[type=checkbox]{vertical-align:-2px;margin-right:4px}
.bfr-modal .ft{padding:12px 18px;border-top:1px solid #eee;display:flex;gap:10px;justify-content:flex-end;flex:none}
.bfr-hint{font-size:11.5px;color:#9499a0;margin:2px 0 0;line-height:1.55}
.bfr-hint b{color:#d0507a}
.bfr-x{border:none;background:rgba(255,255,255,.2);color:#fff;border-radius:50%;width:26px;height:26px;cursor:pointer;font-size:13px;line-height:1;flex:none}
.bfr-x:hover{background:rgba(255,255,255,.4)}
.bfr-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:7px 14px;border-top:1px solid #eee;background:#fafbfc;font-size:11.5px;color:#9499a0}
.bfr-link{color:#fb7299;cursor:pointer;text-decoration:none}
.bfr-link:hover{text-decoration:underline}
.bfr-check{width:16px;height:16px;cursor:pointer}
`;
  }

  function ensureUI() {
    if (UI) return UI;
    GM_addStyle(cssText());

    const mask = document.createElement('div');
    mask.className = 'bfr-mask';

    const fab = document.createElement('button');
    fab.className = 'bfr-fab';
    fab.title = '哔哩哔哩 · 关注回顾：类型概括 / 最后更新 / 最火视频 / 年度关注史 / 批量取关';
    fab.innerHTML = '<span style="font-size:16px">📋</span>&nbsp;关注回顾';

    const root = document.createElement('div');
    root.className = 'bfr-root';
    root.innerHTML =
      '<div class="bfr-head"></div>' +
      '<div class="bfr-progress"><span id="bfr-ptext">…</span><div class="bfr-bar"><i id="bfr-pfill"></i></div>' +
      '<button class="bfr-btn" id="bfr-pcancel">取消</button></div>' +
      '<div class="bfr-toolbar"></div>' +
      '<div class="bfr-stats"></div>' +
      '<div class="bfr-list"></div>' +
      '<div class="bfr-foot"></div>';

    const modal = document.createElement('div');
    modal.className = 'bfr-modal';

    const toast = document.createElement('div');
    toast.className = 'bfr-toast';
    toast.style.display = 'none';

    document.body.appendChild(mask);
    document.body.appendChild(root);
    document.body.appendChild(modal);
    document.body.appendChild(fab);
    document.body.appendChild(toast);

    UI = { fab: fab, root: root, mask: mask, modal: modal, toast: toast };

    fab.addEventListener('click', togglePanel);
    mask.addEventListener('click', closePanel);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && UI && UI.root.classList.contains('open')) closePanel();
    });
    const pc = root.querySelector('#bfr-pcancel');
    if (pc) pc.addEventListener('click', function () { if (scanState) scanState.cancelled = true; });

    const listEl = root.querySelector('.bfr-list');
    listEl.addEventListener('change', function (ev) {
      const cb = ev.target;
      if (cb && cb.matches && cb.matches('input.bfr-check')) {
        const mid = cb.getAttribute('data-mid');
        if (cb.checked) view.selected[mid] = true;
        else delete view.selected[mid];
        const row = cb.closest ? cb.closest('.bfr-row') : null;
        if (row) row.classList.toggle('sel-on', !!cb.checked);
        renderManageBar();
      }
    });
    listEl.addEventListener('click', function (ev) {
      const t = ev.target;
      if (!t || !t.getAttribute) return;
      if (t.getAttribute('data-clear-cat') !== null) { view.catFilter = null; renderStats(); renderList(); return; }
      if (t.getAttribute('data-clear-year') !== null) { view.yearFilter = null; renderStats(); renderList(); return; }
      const bucket = t.getAttribute('data-bucket');
      const cat = t.getAttribute('data-cat');
      const year = t.getAttribute('data-year-filter');
      if (bucket) { view.tab = bucket; view.mode = 'list'; renderAll(); }
      else if (cat) { view.catFilter = cat; view.mode = 'list'; view.tab = 'all'; renderAll(); }
      else if (year) { view.yearFilter = Number(year); view.mode = 'list'; view.tab = 'all'; renderAll(); }
    });

    renderHead();
    renderToolbar();
    renderStats();
    renderList();
    renderFoot();
    return UI;
  }

  function renderHead() {
    const head = UI.root.querySelector('.bfr-head');
    const acc = STORE.account;
    const s = stats();
    head.innerHTML =
      '<h1>📋 关注回顾</h1>' +
      '<span class="sub">' + (acc ? esc(acc.uname) : '未登录') + ' · 关注 ' + s.total + ' 人 · 互关 ' + s.mutual + '</span>' +
      '<span class="sp"></span>' +
      '<button class="bfr-btn" data-act="refresh">🔄 更新数据</button>' +
      '<button class="bfr-btn primary" data-act="ai">✨ AI 概括</button>' +
      '<button class="bfr-btn" data-act="export">📦 导出</button>' +
      '<button class="bfr-btn" data-act="settings">⚙ 设置</button>' +
      '<button class="bfr-x" data-act="close" title="关闭">✕</button>';
    head.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const act = btn.getAttribute('data-act');
        if (act === 'close') closePanel();
        else if (act === 'refresh') askRefresh();
        else if (act === 'ai') runLlmAll();
        else if (act === 'export') askExport();
        else if (act === 'settings') openSettings();
      });
    });
  }

  function renderToolbar() {
    const toolbar = UI.root.querySelector('.bfr-toolbar');
    const tabs = [
      ['all', '全部'], ['recent', '近30天'], ['medium', '1~6月'], ['long', '6~12月'],
      ['dead', '停更超1年'], ['novideo', '无投稿'], ['deleted', '已注销']
    ];
    let t = '';
    tabs.forEach(function (x) {
      t += '<button class="bfr-tab' + (view.tab === x[0] && view.mode === 'list' ? ' on' : '') +
        '" data-tab="' + x[0] + '">' + x[1] + '</button>';
    });
    toolbar.innerHTML =
      t +
      '<input class="bfr-search" placeholder="🔍 搜昵称 / 类型 / 视频标题…" value="' + esc(view.search) + '">' +
      '<select class="bfr-select" data-sort>' +
      '<option value="recent"' + (view.sort === 'recent' ? ' selected' : '') + '>最近更新↓</option>' +
      '<option value="oldest"' + (view.sort === 'oldest' ? ' selected' : '') + '>停更最久↓</option>' +
      '<option value="follow"' + (view.sort === 'follow' ? ' selected' : '') + '>关注时间↓</option>' +
      '<option value="play"' + (view.sort === 'play' ? ' selected' : '') + '>最火播放↓</option>' +
      '<option value="name"' + (view.sort === 'name' ? ' selected' : '') + '>按昵称</option>' +
      '</select>' +
      '<select class="bfr-select" data-minplay title="按最火视频播放量筛选">' +
      '<option value="0"' + (!view.minPlay ? ' selected' : '') + '>最火不限</option>' +
      '<option value="100000"' + (view.minPlay === 100000 ? ' selected' : '') + '>最火≥10万</option>' +
      '<option value="1000000"' + (view.minPlay === 1000000 ? ' selected' : '') + '>最火≥100万</option>' +
      '<option value="10000000"' + (view.minPlay === 10000000 ? ' selected' : '') + '>最火≥1000万</option>' +
      '</select>' +
      '<button class="bfr-btn dark" data-view="1">' +
      (view.mode === 'list' ? '📊 图表' : '📋 列表') + '</button>' +
      '<button class="bfr-btn ' + (view.manage ? 'primary' : 'dark') + '" data-manage="1">☑ 管理</button>';

    toolbar.querySelectorAll('.bfr-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        view.tab = btn.getAttribute('data-tab');
        view.mode = 'list';
        view.catFilter = null;
        view.yearFilter = null;
        renderToolbar();
        renderStats();
        renderList();
      });
    });
    toolbar.querySelector('.bfr-search').addEventListener('input', debounce(function (ev) {
      view.search = ev.target.value;
      renderList();
    }, 200));
    toolbar.querySelector('[data-sort]').addEventListener('change', function (ev) {
      view.sort = ev.target.value;
      renderList();
    });
    toolbar.querySelector('[data-minplay]').addEventListener('change', function (ev) {
      view.minPlay = parseInt(ev.target.value, 10) || 0;
      renderList();
    });
    toolbar.querySelector('[data-view]').addEventListener('click', function () {
      view.mode = view.mode === 'list' ? 'charts' : 'list';
      renderToolbar();
      renderList();
    });
    toolbar.querySelector('[data-manage]').addEventListener('click', function () {
      view.manage = !view.manage;
      if (!view.manage) view.selected = {};
      renderToolbar();
      renderStats();
      renderList();
    });
  }

  function renderManageBar() {
    let bar = UI.root.querySelector('.bfr-managebar');
    if (!view.manage) { if (bar) bar.remove(); return; }
    const count = Object.keys(view.selected).length;
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'bfr-managebar';
      const toolbar = UI.root.querySelector('.bfr-toolbar');
      toolbar.parentNode.insertBefore(bar, toolbar.nextSibling);
    }
    bar.innerHTML =
      '<span>已选 <b>' + count + '</b> 位</span>' +
      '<button class="bfr-btn dark" data-m="all">全选当前列表</button>' +
      '<button class="bfr-btn dark" data-m="none">清空选择</button>' +
      '<span style="flex:1"></span>' +
      '<button class="bfr-btn danger" data-m="del"' + (count ? '' : ' disabled') + '>🗑 取关选中（' + count + '）</button>';
    bar.querySelector('[data-m=all]').addEventListener('click', function () {
      visibleItems().forEach(function (it) { view.selected[it.mid] = true; });
      renderList();
      renderManageBar();
    });
    bar.querySelector('[data-m=none]').addEventListener('click', function () {
      view.selected = {};
      renderList();
      renderManageBar();
    });
    bar.querySelector('[data-m=del]').addEventListener('click', function () {
      const mids = Object.keys(view.selected);
      if (mids.length) runBatchUnfollow(mids);
    });
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  function renderStats() {
    const el = UI.root.querySelector('.bfr-stats');
    const s = stats();
    const total = s.total || 1;
    const pct = function (n) { return Math.round(n / total * 100); };
    let html =
      '<span class="bfr-chip">近30天更新 <b>' + s.recent + '</b> (' + pct(s.recent) + '%)</span>' +
      '<span class="bfr-chip">半年内 <b>' + (s.recent + s.medium) + '</b></span>' +
      '<span class="bfr-chip">停更超1年 <b>' + s.dead + '</b></span>' +
      '<span class="bfr-chip">无投稿 <b>' + s.novideo + '</b></span>' +
      '<span class="bfr-chip">已注销 <b>' + s.deleted + '</b></span>' +
      '<span class="bfr-chip">互关 <b>' + s.mutual + '</b></span>' +
      (s.ai ? '<span class="bfr-chip">AI 已概括 <b>' + s.ai + '</b></span>' : '');
    if (view.catFilter) {
      html += '<span class="bfr-chip filter">类型：' + esc(view.catFilter) + '<span class="x" data-clear-cat="">✕</span></span>';
    }
    if (view.yearFilter) {
      html += '<span class="bfr-chip filter">关注年份：' + view.yearFilter + '<span class="x" data-clear-year="">✕</span></span>';
    }
    el.innerHTML = html;
    el.querySelectorAll('[data-clear-cat]').forEach(function (x) {
      x.addEventListener('click', function () { view.catFilter = null; renderStats(); renderList(); });
    });
    el.querySelectorAll('[data-clear-year]').forEach(function (x) {
      x.addEventListener('click', function () { view.yearFilter = null; renderStats(); renderList(); });
    });
    renderManageBar();
  }

  function renderFoot() {
    const el = UI.root.querySelector('.bfr-foot');
    el.innerHTML =
      '本地归纳类型（不上传数据）｜AI 概括需在 ⚙ 填 API Key｜关注时间为 B 站 mtime（互关后会刷新，属近似值）｜最后扫描：' +
      (STORE.savedAt ? new Date(STORE.savedAt).toLocaleString() : '尚未扫描') +
      '　<span class="bfr-link" data-export="md">导出 Markdown</span> · ' +
      '<span class="bfr-link" data-export="json">导出 JSON</span>';
    el.querySelectorAll('[data-export]').forEach(function (a) {
      a.addEventListener('click', function () { exportData(a.getAttribute('data-export')); });
    });
  }

  function visibleItems() {
    const q = view.search.trim().toLowerCase();
    const items = [];
    STORE.order.forEach(function (mid) {
      const it = STORE.items[mid];
      if (!it) return;
      if (view.tab !== 'all' && bucketOf(it) !== view.tab) return;
      if (view.catFilter && ((it.cat && it.cat.major) || '未知') !== view.catFilter) return;
      if (view.minPlay && !(it.top && (it.top.play || 0) >= view.minPlay)) return;
      if (view.yearFilter) {
        const y = it.followTs ? new Date(it.followTs * 1000).getFullYear() : null;
        if (y !== view.yearFilter) return;
      }
      if (q) {
        const hay = ((it.uname || '') + ' ' + (it.sign || '') + ' ' +
          ((it.cat && it.cat.label) || '') + ' ' + ((it.cat && it.cat.detail) || '') + ' ' +
          ((it.llm && it.llm.type) || '') + ' ' + ((it.llm && it.llm.why) || '') + ' ' +
          (it.last ? it.last.title : '') + ' ' + (it.top ? it.top.title : '')).toLowerCase();
        if (hay.indexOf(q) < 0) return;
      }
      items.push(it);
    });
    const sort = view.sort;
    items.sort(function (a, b) {
      if (sort === 'name') return String(a.uname).localeCompare(String(b.uname), 'zh');
      if (sort === 'follow') return (b.followTs || 0) - (a.followTs || 0);
      if (sort === 'play') return ((b.top && b.top.play) || 0) - ((a.top && a.top.play) || 0);
      const ad = a.last ? a.last.created : -1;
      const bd = b.last ? b.last.created : -1;
      if (sort === 'oldest') {
        if (ad < 0 && bd < 0) return (a.followTs || 0) - (b.followTs || 0);
        if (ad < 0) return 1;
        if (bd < 0) return -1;
        return ad - bd;
      }
      return bd - ad;
    });
    return items;
  }

  function renderList() {
    const listEl = UI.root.querySelector('.bfr-list');
    if (view.mode === 'charts') { renderCharts(listEl); return; }
    const items = visibleItems();
    if (!items.length) {
      listEl.innerHTML =
        '<div class="bfr-empty"><div class="big">🗂️</div>' +
        (STORE.order.length
          ? '当前筛选下没有匹配的 UP 主。'
          : '还没有数据。<br>点击右上角「🔄 更新数据」开始扫描你关注的全部 UP 主。') +
        '</div>';
      return;
    }
    const LIMIT = 500;
    const shown = items.slice(0, LIMIT);
    let html = '';
    shown.forEach(function (it) { html += rowHtml(it); });
    if (items.length > LIMIT) {
      html += '<div class="bfr-more">共匹配 ' + items.length + ' 条，仅显示前 ' + LIMIT +
        ' 条，请用搜索 / 筛选缩小范围</div>';
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll('img[data-src]').forEach(function (img) {
      img.src = img.getAttribute('data-src');
    });
  }

  function rowHtml(it) {
    const b = bucketOf(it);
    const badgeMap = {
      recent: ['b-recent', '近30天更新'],
      medium: ['b-medium', '1~6个月前'],
      long: ['b-long', '6~12个月前'],
      dead: ['b-dead', '停更超1年'],
      novideo: ['b-novideo', (it.attr === 6 ? '互关·无投稿' : '无投稿')],
      deleted: ['b-deleted', '账号已注销'],
      none: ['b-none', (it.status === 'error' ? '采集失败' : '待采集')]
    };
    const badge = badgeMap[b] || badgeMap.none;
    const typeLabel = (it.llm && it.llm.type) ? it.llm.type : (it.cat ? it.cat.label : '—');
    const typeDetail = (it.llm && it.llm.why) ? it.llm.why : (it.cat ? it.cat.detail : '');
    const faceImg = it.face
      ? '<img data-src="' + esc(faceUrl(it.face)) + '" alt="">'
      : '<img alt="" style="visibility:hidden">';
    const officialLine = (it.official && it.official.desc) || (it.official && it.official.type === 1 ? '机构认证' : '');
    const mutual = (it.attr === 6) ? '<span class="bfr-mutual">互关</span>' : '';

    let lastTxt;
    if (!it.last) {
      lastTxt = '<div class="bfr-last bfr-time">' + esc(trunc(it.err || '无投稿记录', 60)) + '</div>';
    } else {
      const cad = (it.mediaGapDays != null)
        ? '<div class="bfr-time" style="margin-top:2px">更新间隔约 ' + it.mediaGapDays + ' 天</div>'
        : '';
      const hot = it.top
        ? '<a class="hot' + ((it.top.play || 0) >= 10000000 ? ' mega' : ((it.top.play || 0) >= 1000000 ? ' big' : '')) +
        '" target="_blank" rel="noopener" href="https://www.bilibili.com/video/' + esc(it.top.bvid) +
        '" title="最火：' + esc(it.top.title) + '">🔥 ' + esc(trunc(it.top.title, 34)) +
        (it.top.play ? '（' + esc(fmtPlay(it.top.play)) + '播放' + (it.top.created ? '，' + esc(fmtDate(it.top.created)) : '') + '）' : '') +
        '</a>'
        : '';
      lastTxt = '<div class="bfr-last">' +
        '<a class="vt" target="_blank" rel="noopener" href="https://www.bilibili.com/video/' + esc(it.last.bvid) + '" title="' + esc(it.last.title) + '">' + esc(it.last.title) + '</a>' +
        (it.last.zone ? '<span class="zn"> ' + esc(it.last.zone) + '</span>' : '') + cad + hot +
        '</div>';
    }

    let timeTxt;
    if (!it.last) timeTxt = '<span class="bfr-time">—</span>';
    else {
      const d = daysAgo(it.last.created);
      timeTxt = esc(fmtDate(it.last.created)) + '<br><span class="bfr-time">' + (d == null ? '' : esc(fmtSpan(d))) + '</span>';
    }
    const followTxt = it.followTs
      ? '<div class="bfr-time">' + esc(fmtYm(it.followTs)) + '</div>'
      : '<div class="bfr-time">—</div>';
    const aiBadge = (it.llm && it.llm.type) ? '<span class="bfr-ai">AI</span>' : '';
    const selCell = view.manage
      ? '<div><input type="checkbox" class="bfr-check" data-mid="' + it.mid + '"' + (view.selected[it.mid] ? ' checked' : '') + '></div>'
      : '';
    return '<div class="bfr-row' + (view.manage ? ' with-sel' : '') + (view.selected[it.mid] ? ' sel-on' : '') + '">' +
      selCell +
      '<div class="bfr-user">' + faceImg +
      '<div class="uinfo">' +
      '<a class="nm" target="_blank" rel="noopener" href="https://space.bilibili.com/' + it.mid + '" title="' + esc(it.uname) + '">' + esc(it.uname) + '</a>' + mutual +
      (officialLine
        ? '<div class="off" title="' + esc(officialLine) + '">' + esc(trunc(officialLine, 26)) + '</div>'
        : '<div class="off none">' + (it.attr === 6 ? '互相关注' : 'UP主') + '</div>') +
      '</div></div>' +
      '<div class="bfr-type"><div class="tl">' + aiBadge + '<span>' + esc(typeLabel || '—') + '</span></div>' +
      (typeDetail ? '<div class="dt">' + esc(trunc(typeDetail, 180)) + '</div>' : '') +
      '</div>' +
      lastTxt +
      '<div class="bfr-time">' + timeTxt + '</div>' +
      '<div><span class="bfr-badge ' + badge[0] + '">' + badge[1] + '</span></div>' +
      followTxt +
      '</div>';
  }

  function faceUrl(u) {
    if (!u) return '';
    if (u.indexOf('//') === 0) return 'https:' + u;
    return u;
  }

  /* ---------- 饼图 / 图表 ---------- */

  function donutSvg(data, size) {
    size = size || 190;
    const total = data.reduce(function (s, d) { return s + d.value; }, 0);
    if (!total) return '<div class="bfr-time">暂无数据</div>';
    const cx = size / 2, cy = size / 2, rO = size / 2 - 4, rI = rO * 0.6;
    const pt = function (a, r) { return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
    let paths = '';
    if (data.length === 1) {
      paths = '<circle cx="' + cx + '" cy="' + cy + '" r="' + ((rO + rI) / 2).toFixed(2) +
        '" fill="none" stroke="' + data[0].color + '" stroke-width="' + (rO - rI).toFixed(2) + '"></circle>';
    } else {
      let ang = -Math.PI / 2;
      data.forEach(function (d) {
        const sweep = (d.value / total) * Math.PI * 2;
        const a0 = ang, a1 = ang + sweep;
        const large = sweep > Math.PI ? 1 : 0;
        const p0 = pt(a0, rO), p1 = pt(a1, rO), p2 = pt(a1, rI), p3 = pt(a0, rI);
        paths += '<path d="M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) +
          ' A' + rO + ' ' + rO + ' 0 ' + large + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2) +
          ' L' + p2[0].toFixed(2) + ' ' + p2[1].toFixed(2) +
          ' A' + rI + ' ' + rI + ' 0 ' + large + ' 0 ' + p3[0].toFixed(2) + ' ' + p3[1].toFixed(2) + ' Z" fill="' + d.color + '"></path>';
        ang = a1;
      });
    }
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' + paths +
      '<text x="' + cx + '" y="' + (cy - 2) + '" text-anchor="middle" font-size="20" font-weight="600" fill="#18191c">' + total + '</text>' +
      '<text x="' + cx + '" y="' + (cy + 16) + '" text-anchor="middle" font-size="11" fill="#9499a0">总数</text>' +
      '</svg>';
  }

  function legendHtml(data, total, attrName) {
    let h = '<div class="bfr-legend">';
    data.forEach(function (d) {
      const p = total ? Math.round(d.value / total * 100) : 0;
      const attr = attrName === 'bucket' ? ' data-bucket="' + esc(d.key || '') + '"'
        : (attrName === 'cat' ? ' data-cat="' + esc(d.label) + '"' : '');
      h += '<div class="bfr-lg"' + attr + ' title="点击筛选">' +
        '<span class="dot" style="background:' + d.color + '"></span>' +
        '<span class="lb">' + esc(d.label) + '</span>' +
        '<span class="vl">' + d.value + ' · ' + p + '%</span></div>';
    });
    return h + '</div>';
  }

  function renderCharts(listEl) {
    const t = timeCounts();
    const tTotal = t.reduce(function (s, d) { return s + d.value; }, 0);
    const tData = t.map(function (d, i) {
      return { key: d.key, label: d.label, value: d.value, color: PALETTE[i % PALETTE.length] };
    });

    const types = typeCounts();
    const topN = 8;
    const typeData = types.slice(0, topN).map(function (d, i) {
      return { label: d.label, value: d.value, color: PALETTE[i % PALETTE.length] };
    });
    if (types.length > topN) {
      const rest = types.slice(topN).reduce(function (s, d) { return s + d.value; }, 0);
      typeData.push({ label: '其他', value: rest, color: '#c9c9c9' });
    }
    const typeTotal = typeData.reduce(function (s, d) { return s + d.value; }, 0);

    const ys = yearStats();
    let yearHtml = '';
    if (!ys.years.length) {
      yearHtml = '<div class="bfr-time">没有可用的关注时间数据（B 站未返回 mtime）。</div>';
    } else {
      ys.years.forEach(function (y) {
        const topM = y.majors.slice(0, 4);
        let segments = '';
        topM.forEach(function (m, i) {
          segments += '<i style="width:' + (m.value / y.count * 100).toFixed(1) + '%;background:' +
            PALETTE[i % PALETTE.length] + '"></i>';
        });
        const chipStr = y.majors.slice(0, 4).map(function (m) {
          return '<span>' + esc(m.label) + ' ' + Math.round(m.value / y.count * 100) + '%</span>';
        }).join('');
        const mainLine = y.majors.length
          ? '最多的是「<b>' + esc(y.majors[0].label) + '</b>」（' + Math.round(y.majors[0].value / y.count * 100) + '%）'
          : '';
        yearHtml += '<div class="bfr-year">' +
          '<div class="yr">' + y.year + '</div>' +
          '<div class="ct">关注 ' + y.count + ' 人</div>' +
          '<div><div class="sbar">' + segments + '</div>' +
          '<div class="chips">' + chipStr + '</div>' +
          '<div style="margin-top:3px;font-size:11.5px;color:#8a9099">' + mainLine +
          '　<a class="act" data-year-filter="' + y.year + '">查看这一年的关注 →</a></div></div>' +
          '</div>';
      });
    }
    const latest = ys.years[0];
    const summary = latest
      ? '<div class="bfr-summary">你在 <b>' + latest.year + '</b> 年关注了 <b>' + latest.count + '</b> 位 UP 主' +
      (latest.majors.length
        ? '，其中最多的是「<b>' + esc(latest.majors[0].label) + '</b>」（' +
        Math.round(latest.majors[0].value / latest.count * 100) + '%）'
        : '') + '。' +
      (ys.unknown ? '另有 ' + ys.unknown + ' 位缺少关注时间。' : '') + '</div>'
      : '';

    listEl.innerHTML =
      '<div class="bfr-charts">' +
      '<div class="bfr-card"><h3>① 最后发视频时间占比（' + tTotal + ' 人）</h3>' +
      '<div class="bfr-pie">' + donutSvg(tData) + legendHtml(tData, tTotal, 'bucket') + '</div>' +
      '<p class="bfr-hint">点击图例可按该区间筛选列表。</p></div>' +

      '<div class="bfr-card"><h3>② 关注类型占比（' + typeTotal + ' 人）</h3>' +
      '<div class="bfr-pie">' + donutSvg(typeData) + legendHtml(typeData, typeTotal, 'cat') + '</div>' +
      '<p class="bfr-hint">类型来自本地规则（认证 / 分区 / 签名）；点击图例筛选该类型。</p></div>' +

      '<div class="bfr-card wide"><h3>③ 按关注年份的类型分布</h3>' + summary + yearHtml +
      '<p class="bfr-hint">关注时间取自 B 站关注列表接口的 mtime；互关（互粉）后该时间会刷新，因此为近似值。</p></div>' +
      '</div>';
  }

  function renderAll() {
    if (!UI) return;
    renderHead();
    renderToolbar();
    renderStats();
    renderList();
    renderFoot();
  }

  /* ---------- 进度条（按真实数量推进） ---------- */
  function setProgress(ratio, text) {
    if (!UI) return;
    const prog = UI.root.querySelector('.bfr-progress');
    const ptext = UI.root.querySelector('#bfr-ptext');
    const fill = UI.root.querySelector('#bfr-pfill');
    prog.classList.add('on');
    if (text != null) ptext.textContent = text;
    if (ratio != null) fill.style.width = (Math.max(0, Math.min(1, ratio)) * 100).toFixed(2) + '%';
  }
  function hideProgress() {
    if (!UI) return;
    const prog = UI.root.querySelector('.bfr-progress');
    const fill = UI.root.querySelector('#bfr-pfill');
    prog.classList.remove('on');
    if (fill) fill.style.width = '0%';
  }

  function togglePanel() {
    ensureUI();
    const open = UI.root.classList.toggle('open');
    UI.mask.classList.toggle('open', open);
    if (open) renderAll();
  }
  function closePanel() {
    ensureUI();
    UI.root.classList.remove('open');
    UI.mask.classList.remove('open');
  }

  /* ---------- 完成通知：每次扫描最多一条，且会自动消失 ---------- */
  let lastNotifyAt = 0;
  function notifyScanDone(text) {
    if (!SETTINGS.notifyOnDone) return;
    const now = Date.now();
    // 去重窗口：10 秒内只允许一条，避免并发/重复触发把通知刷屏
    if (now - lastNotifyAt < 10000) return;
    lastNotifyAt = now;
    try {
      GM_notification({
        title: '关注回顾 · 数据已更新',
        text: text,
        timeout: 6000,          // 6 秒后自动消失，不在通知中心里越堆越多
        onclick: function () { if (typeof togglePanel === 'function') togglePanel(); }
      });
    } catch (e) { /* ignore */ }
  }

  /* ---------- toast ---------- */
  let toastTimer = null;
  function showToast(msg) {
    ensureUI();
    UI.toast.textContent = msg;
    UI.toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { UI.toast.style.display = 'none'; }, 3800);
  }

  /* ---------- 刷新 ---------- */
  function askRefresh() {
    ensureUI();
    const now = nowTs();
    const ttl = SETTINGS.ttlHours * 3600 * 1000;
    let staleCount = 0, pendingCount = 0;
    STORE.order.forEach(function (mid) {
      const it = STORE.items[mid];
      if (!it) return;
      if (it.status === 'ok' || it.status === 'novideo' || it.status === 'deleted') {
        if (now - (it.fetchedAt || 0) > ttl) staleCount++;
      } else pendingCount++;
    });
    const hasData = !!STORE.savedAt;
    if (!hasData || pendingCount > 0 || staleCount > 0) {
      runScan(pendingCount > 0 && !hasData ? 'all' : 'stale');
      return;
    }
    if (confirm('数据在缓存有效期内（' + SETTINGS.ttlHours + ' 小时）。\n\n「确定」：忽略缓存、全量重新抓取；\n「取消」：不更新。')) {
      runScan('all');
    }
  }

  /* ---------- 设置 ---------- */
  function openSettings() {
    ensureUI();
    const s = SETTINGS;
    UI.modal.className = 'bfr-modal open';
    UI.modal.innerHTML =
      '<h2>⚙ 设置</h2><div class="bd">' +
      '<label class="small"><input type="checkbox" id="bfr-llm" ' + (s.llmEnabled ? 'checked' : '') + '> 启用「大模型概括」(AI)</label>' +
      '<p class="bfr-hint">启用后，会把每个 UP 主的 <b>昵称 / 认证 / 签名 / 最火视频 / 最近视频标题</b> 发送到所填模型服务商。' +
      '不启用时使用本地规则分析，完全不上传任何内容。若使用其它厂商，请把其域名加入脚本头部的 @connect 列表。</p>' +
      '<label>API 地址</label><input type="text" id="bfr-base" value="' + esc(s.llmBase) + '" placeholder="https://api.deepseek.com">' +
      '<label>API Key（仅保存在本机油猴存储中）</label><input type="password" id="bfr-key" value="' + esc(s.llmKey) + '" placeholder="sk-…">' +
      '<label>模型</label><input type="text" id="bfr-model" value="' + esc(s.llmModel) + '" placeholder="deepseek-chat">' +
      '<label>每批 AI 概括人数</label><input type="number" id="bfr-batch" min="1" max="50" value="' + s.llmBatch + '">' +
      '<label>采集并发数（1-6，越小越不容易被风控）</label><input type="number" id="bfr-conc" min="1" max="6" value="' + s.concurrency + '">' +
      '<label>缓存有效期（小时）</label><input type="number" id="bfr-ttl" min="1" max="168" value="' + s.ttlHours + '">' +
      '<label>批量取关间隔（毫秒，建议 ≥600）</label><input type="number" id="bfr-ufgap" min="300" max="5000" step="100" value="' + s.unfollowGap + '">' +
      '<label class="small"><input type="checkbox" id="bfr-fetchtop" ' + (s.fetchTop ? 'checked' : '') + '> 采集「最火视频」（每个 UP 多一次请求）</label>' +
      '<label class="small"><input type="checkbox" id="bfr-notify" ' + (s.notifyOnDone ? 'checked' : '') + '> 完成后系统通知</label>' +
      '<p class="bfr-hint">数据版本 ' + VERSION + '｜当前缓存 ' + STORE.order.length + ' 位 UP 主。<span class="bfr-link" id="bfr-clear">清空缓存</span></p>' +
      '</div><div class="ft">' +
      '<button class="bfr-btn dark" id="bfr-cancel">关闭</button>' +
      '<button class="bfr-btn primary" id="bfr-save">保存</button>' +
      '</div>';

    UI.modal.querySelector('#bfr-save').addEventListener('click', function () {
      SETTINGS.llmEnabled = UI.modal.querySelector('#bfr-llm').checked;
      SETTINGS.llmBase = UI.modal.querySelector('#bfr-base').value.trim() || DEF_SETTINGS.llmBase;
      SETTINGS.llmKey = UI.modal.querySelector('#bfr-key').value.trim();
      SETTINGS.llmModel = UI.modal.querySelector('#bfr-model').value.trim() || DEF_SETTINGS.llmModel;
      SETTINGS.llmBatch = Math.min(50, Math.max(1, parseInt(UI.modal.querySelector('#bfr-batch').value, 10) || 10));
      SETTINGS.concurrency = Math.min(6, Math.max(1, parseInt(UI.modal.querySelector('#bfr-conc').value, 10) || 3));
      SETTINGS.ttlHours = Math.min(168, Math.max(1, parseInt(UI.modal.querySelector('#bfr-ttl').value, 10) || 6));
      SETTINGS.unfollowGap = Math.min(5000, Math.max(300, parseInt(UI.modal.querySelector('#bfr-ufgap').value, 10) || 900));
      SETTINGS.fetchTop = UI.modal.querySelector('#bfr-fetchtop').checked;
      SETTINGS.notifyOnDone = UI.modal.querySelector('#bfr-notify').checked;
      saveSettings(SETTINGS);
      UI.modal.className = 'bfr-modal';
      showToast('设置已保存。');
    });
    UI.modal.querySelector('#bfr-cancel').addEventListener('click', function () {
      UI.modal.className = 'bfr-modal';
    });
    const clear = UI.modal.querySelector('#bfr-clear');
    if (clear) clear.addEventListener('click', function () {
      if (confirm('确定清空全部缓存数据？（不影响你的 B 站账号）')) {
        GM_deleteValue(STORE_KEY);
        STORE = { version: VERSION, savedAt: 0, account: STORE.account, order: [], items: {}, llmRanAt: 0 };
        view.selected = {};
        renderAll();
        showToast('缓存已清空。');
      }
    });
  }

  /* ---------- 导出 ---------- */
  function askExport() {
    if (confirm('导出方式：\n\n「确定」= JSON（结构化，便于程序处理）\n「取消」= Markdown（表格，便于阅读）')) {
      exportData('json');
    } else {
      exportData('md');
    }
  }

  function buildReport() {
    const s = stats();
    const items = STORE.order.map(function (mid) {
      const it = STORE.items[mid];
      if (!it) return null;
      const catLabel = (it.llm && it.llm.type) ? it.llm.type : (it.cat ? it.cat.label : '');
      const catDetail = (it.llm && it.llm.why) ? it.llm.why : (it.cat ? it.cat.detail : '');
      const d = it.last ? daysAgo(it.last.created) : null;
      return {
        mid: it.mid,
        uname: it.uname,
        space: 'https://space.bilibili.com/' + it.mid,
        face: it.face,
        official: (it.official && it.official.desc) || '',
        sign: it.sign || '',
        mutual: it.attr === 6,
        followTime: it.followTs ? new Date(it.followTs * 1000).toISOString() : null,
        followYear: it.followTs ? new Date(it.followTs * 1000).getFullYear() : null,
        status: it.status,
        bucket: bucketOf(it),
        type: catLabel || '',
        typeDetail: catDetail || '',
        typeSource: (it.llm && it.llm.type) ? 'llm' : 'local',
        uploadTotal: it.total || 0,
        lastVideo: it.last ? {
          bvid: it.last.bvid,
          title: it.last.title,
          url: it.last.bvid ? 'https://www.bilibili.com/video/' + it.last.bvid : '',
          publishedAt: fmtDate(it.last.created),
          daysAgo: d,
          play: it.last.play,
          zone: it.last.zone
        } : null,
        topVideo: it.top ? {
          bvid: it.top.bvid,
          title: it.top.title,
          url: it.top.bvid ? 'https://www.bilibili.com/video/' + it.top.bvid : '',
          publishedAt: fmtDate(it.top.created),
          play: it.top.play
        } : null,
        mediaGapDays: it.mediaGapDays,
        zones: it.zones || [],
        fetchedAt: it.fetchedAt ? new Date(it.fetchedAt).toISOString() : null,
        err: it.err || ''
      };
    }).filter(Boolean);

    return {
      plugin: '哔哩哔哩 · 关注回顾',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      account: STORE.account || null,
      stats: s,
      followCount: STORE.order.length,
      yearStats: yearStats().years.map(function (y) {
        return { year: y.year, count: y.count, majors: y.majors };
      }),
      items: items
    };
  }

  function exportData(kind) {
    ensureUI();
    const rep = buildReport();
    if (!rep.items.length) { showToast('没有可导出的数据（请先更新数据）。'); return; }
    const stamp = new Date();
    const pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    let fname = 'bilibili-关注回顾-' + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) +
      '-' + pad(stamp.getHours()) + pad(stamp.getMinutes());
    let text, type;
    if (kind === 'json') {
      text = JSON.stringify(rep, null, 2);
      type = 'application/json';
      fname += '.json';
    } else {
      const L = [];
      const escPipe = function (x) { return String(x == null ? '' : x).replace(/\|/g, '\\|').replace(/\n/g, ' '); };
      L.push('# 哔哩哔哩 · 关注回顾报告');
      L.push('');
      L.push('- 账号：' + (STORE.account ? STORE.account.uname + '（mid ' + STORE.account.mid + '）' : '未知'));
      L.push('- 关注总数：' + rep.followCount);
      L.push('- 近30天更新：' + rep.stats.recent + '；停更超1年：' + rep.stats.dead +
        '；无投稿：' + rep.stats.novideo + '；已注销：' + rep.stats.deleted);
      L.push('- 导出时间：' + rep.exportedAt);
      L.push('');
      if (rep.yearStats.length) {
        L.push('## 按关注年份');
        L.push('');
        L.push('| 年份 | 关注人数 | 主要类型 |');
        L.push('| --- | --- | --- |');
        rep.yearStats.forEach(function (y) {
          L.push('| ' + y.year + ' | ' + y.count + ' | ' +
            y.majors.slice(0, 4).map(function (m) {
              return escPipe(m.label) + ' ' + Math.round(m.value / y.count * 100) + '%';
            }).join('、') + ' |');
        });
        L.push('');
      }
      L.push('## UP 主明细');
      L.push('');
      L.push('| UP主 | 类型 | 说明/特色 | 最新视频 | 最火视频 | 最后更新 | 距今 | 关注时间 | 状态 |');
      L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      rep.items.forEach(function (it) {
        const lv = it.lastVideo, tv = it.topVideo;
        L.push('| [' + escPipe(it.uname) + '](' + it.space + ') | ' +
          escPipe(it.type || '—') + (it.typeSource === 'llm' ? ' (AI)' : '') + ' | ' +
          escPipe(it.typeDetail) + ' | ' +
          (lv ? '[' + escPipe(lv.title) + '](' + lv.url + ')' : '—') + ' | ' +
          (tv ? '[' + escPipe(tv.title) + '](' + tv.url + ')（' + fmtPlay(tv.play) + '播放）' : '—') + ' | ' +
          (lv ? lv.publishedAt : '—') + ' | ' +
          (lv && lv.daysAgo != null ? fmtSpan(lv.daysAgo) : escPipe(it.err || '—')) + ' | ' +
          (it.followTime ? it.followTime.slice(0, 10) : '—') + ' | ' +
          (BUCKET_LABEL[it.bucket] || it.bucket) + ' |');
      });
      text = L.join('\n');
      type = 'text/markdown;charset=utf-8';
      fname += '.md';
    }
    const blob = new Blob([text], { type: type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 800);
    showToast('已导出：' + fname);
  }

  /* ============================== 初始化 ============================== */

  function boot() {
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', boot);
      return;
    }
    ensureUI();
    setTimeout(function () {
      try {
        GM_registerMenuCommand('📋 打开「关注回顾」面板', function () {
          if (!UI.root.classList.contains('open')) togglePanel();
        });
        GM_registerMenuCommand('🔄 更新关注数据（全量重扫）', function () {
          UI.root.classList.add('open');
          UI.mask.classList.add('open');
          runScan('all');
        });
        GM_registerMenuCommand('📊 打开图表统计', function () {
          UI.root.classList.add('open');
          UI.mask.classList.add('open');
          view.mode = 'charts';
          renderAll();
        });
        GM_registerMenuCommand('⚙ 设置（AI 概括 / 缓存）', openSettings);
      } catch (e) { /* ignore */ }
    }, 200);
  }

  boot();
})();
