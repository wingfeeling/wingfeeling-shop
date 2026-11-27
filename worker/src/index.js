/* ================================================================
   wingfeeling 總店（Cloudflare Workers + D1）
   所有網站共用的「收款＋客服＋許願池」中心。綠界只登記這個網站。

   流程：
     1. 各網站按「購買」→ 呼叫 POST /api/checkout/start（帶該網站的 Firebase 登入憑證）
        → 拿到總店結帳頁網址 pay.html?s=…，整頁跳過去
     2. 使用者在總店結帳頁看到商品、價格、購買須知 → 同意 → 前往綠界付款
     3. 綠界通知 /api/ecpay/notify → 驗證 → 訂單改成已付款 → 「出貨」：
          mode = 'webhook'：用簽章通知該網站的 hook 網址，由該網站把東西加進帳號（AR 寵物、PDF 編輯器）
          mode = 'hub'     ：總店自己記錄權限，網站呼叫 /api/me/entitlements 查（語音轉文字，或以後沒有後端的新服務）
        出貨失敗會記下來，排程每 10 分鐘自動重試，後台也可以手動重送
     4. 付款完把使用者送回原本的網站（return_url?order=訂單編號）

   新增服務：管理後台 →「服務與商品」→ 新增服務、新增商品。不用改程式。

   網址：
     GET  /api/catalog              公開商品目錄（總店首頁用）
     GET  /api/status               綠界是測試環境還是正式收款
     POST /api/checkout/start       各網站呼叫：建立結帳連結
     GET  /api/checkout/session     結帳頁讀取：這次要買哪個服務的商品
     POST /api/checkout/pay         結帳頁按「前往付款」：建立訂單、回傳綠界表單
     POST /api/ecpay/notify         綠界付款通知（伺服器對伺服器）
     ANY  /api/ecpay/result         付款完使用者回來 → 轉回原網站
     GET  /api/order?no=            查訂單狀態（只回狀態，不含個資）
     POST /api/me/entitlements      查自己在某服務的權限（mode = 'hub' 的服務用）
     POST /api/me/orders            我的訂單（所有服務）
     POST /api/support/<動作>        客服・許願池（所有服務共用）
     POST /api/admin/<動作>          管理後台（只有 ADMIN_EMAILS）
   ================================================================ */

/* ============================== 小工具 ============================== */
class ApiError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra || {}; } }
const enc = new TextEncoder();
const now = () => Date.now();
const DAY = 86400000;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256Hex = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const b64url = bytes => { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const fromB64url = s => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const normEmail = e => String(e || '').trim().toLowerCase().slice(0, 200);
const cleanText = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const intOr = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const parseJ = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const iso = ms => ms ? new Date(ms).toISOString() : null;
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
async function readJson(req) { try { return (await req.json()) || {}; } catch { return {}; } }
const isProd = env => env.ECPAY_MODE === 'production';
const ecpayHost = env => isProd(env) ? 'https://payment.ecpay.com.tw' : 'https://payment-stage.ecpay.com.tw';
const storeName = env => env.STORE_NAME || 'wingfeeling 數位商店';
// 台灣時間 yyyy/MM/dd HH:mm:ss（綠界要的格式）
function twNow() {
  const t = new Date(now() + 8 * 3600e3), z = n => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}/${z(t.getUTCMonth() + 1)}/${z(t.getUTCDate())} ${z(t.getUTCHours())}:${z(t.getUTCMinutes())}:${z(t.getUTCSeconds())}`;
}
const twMonthStart = () => { const d = new Date(now() + 8 * 3600e3); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 8 * 3600e3; };
const SLUG_RE = /^[a-z][a-z0-9-]{1,23}$/;
const CODE_RE = /^[A-Za-z0-9_-]{1,40}$/;

/* ============================== 資料表（第一次連線自動建立） ============================== */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, tagline TEXT, description TEXT, url TEXT, buy_url TEXT, return_url TEXT,
     admin_url TEXT, firebase_project TEXT, mode TEXT NOT NULL DEFAULT 'hub', hook_url TEXT, secret TEXT, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS products (sku TEXT PRIMARY KEY, service_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, description TEXT, price INTEGER NOT NULL,
     grant_json TEXT, pay TEXT DEFAULT 'ALL', tag TEXT, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0, updated_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_products_svc ON products(service_id, sort)`,
  `CREATE TABLE IF NOT EXISTS orders (no TEXT PRIMARY KEY, service_id TEXT NOT NULL, sku TEXT NOT NULL, code TEXT, product_name TEXT, amount INTEGER NOT NULL, grant_json TEXT,
     project TEXT, uid TEXT NOT NULL, email TEXT, name TEXT, status TEXT NOT NULL, fulfill TEXT, fulfill_tries INTEGER DEFAULT 0, fulfill_error TEXT, fulfill_at INTEGER,
     ecpay_trade_no TEXT, payment_type TEXT, rtn_code TEXT, rtn_msg TEXT, mode TEXT, note TEXT, created_at INTEGER, paid_at INTEGER, notified_at INTEGER, refunded_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(project, uid)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_time ON orders(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_fulfill ON orders(fulfill)`,
  `CREATE TABLE IF NOT EXISTS entitlements (service_id TEXT NOT NULL, project TEXT NOT NULL, uid TEXT NOT NULL, email TEXT, pro_until INTEGER DEFAULT 0, lifetime INTEGER DEFAULT 0,
     updated_at INTEGER, PRIMARY KEY (service_id, project, uid))`,
  `CREATE INDEX IF NOT EXISTS idx_ent_email ON entitlements(email)`,
  `CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, service_id TEXT NOT NULL, project TEXT, uid TEXT NOT NULL, email TEXT, name TEXT, type TEXT NOT NULL, text TEXT, price INTEGER,
     device TEXT, image_count INTEGER DEFAULT 0, status TEXT, thread TEXT, user_unread INTEGER DEFAULT 0, admin_unread INTEGER DEFAULT 1, source TEXT, created_at INTEGER, updated_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(project, uid)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_upd ON tickets(updated_at)`,
  `CREATE TABLE IF NOT EXISTS ticket_images (ticket_id TEXT NOT NULL, n INTEGER NOT NULL, data TEXT, PRIMARY KEY (ticket_id, n))`,
  `CREATE TABLE IF NOT EXISTS admin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, by_email TEXT, action TEXT, ref TEXT, note TEXT, at INTEGER)`,
];

/* ---------- 第一次啟動時放進去的服務和商品（之後都在管理後台改） ----------
   價格照各網站原本的價格。grant 是「付款成功後要給什麼」，各網站自己看得懂就好：
     PDF 編輯器：pro_days 進階版天數、credits 簽名份數、credit_days 份數期限
     AR 寵物：product = js/catalog.js 裡的商品 ID（要給什麼東西由 AR 寵物自己決定）
     mode 'hub' 的服務（語音轉文字）：pro_days 付費版天數、lifetime: true 永久 */
const ARPET_PETS = [['hamster', '倉鼠', '圓滾滾、臉頰鼓鼓的小倉鼠'], ['alpaca', '羊駝', '毛蓬蓬、脖子長長的羊駝'], ['capybara', '水豚', '永遠一臉放鬆的水豚'], ['phoenix', '鳳凰', '【幻獸系列】火焰神鳥，會在空中飛翔']];
const SEED = [
  { id: 'pdf', name: '凌的萬用pdf編輯器', icon: '📄', sort: 10, mode: 'webhook',
    tagline: '線上改 PDF、簽名、轉檔，批次線上簽名',
    description: 'PDF 編輯器、掃描文字辨識、Word／Excel／PPT 轉檔免費使用；批次線上簽名按份數購買，有簽名才算份數。',
    url: 'https://pdf-editor.wingfeeling.workers.dev/', buy_url: 'https://pdf-editor.wingfeeling.workers.dev/pricing.html',
    return_url: 'https://pdf-editor.wingfeeling.workers.dev/account.html', admin_url: 'https://pdf-editor.wingfeeling.workers.dev/ops.html',
    hook_url: 'https://pdf-editor.wingfeeling.workers.dev/api/shop/hook', firebase_project: 'pdf-editor-54ab7',
    products: [
      ['pro_m', '進階版 1 個月', 49, { pro_days: 31 }, 'Credit', '批次轉檔不限檔案數；批次簽名的檔案不限保存天數。'],
      ['pro_y', '進階版 1 年', 390, { pro_days: 366 }, 'ALL', '批次轉檔不限檔案數；批次簽名的檔案不限保存天數。平均每月約 33 元。'],
      ['sign300', '批次簽名 300 份', 190, { credits: 300, credit_days: 365 }, 'Credit', '300 份文件的線上簽名，365 天內用完；有簽名才算份數。'],
      ['sign1000', '批次簽名 1,000 份＋進階版 1 年', 490, { credits: 1000, credit_days: 365, pro_days: 366 }, 'ALL', '1,000 份線上簽名，另含進階版 1 年。', '學校最常選'],
      ['sign3000', '批次簽名 3,000 份＋進階版 1 年', 990, { credits: 3000, credit_days: 365, pro_days: 366 }, 'ALL', '3,000 份線上簽名，另含進階版 1 年。'],
    ] },
  { id: 'arpet', name: 'AR 寵物召喚', icon: '🐾', sort: 20, mode: 'webhook',
    tagline: '在真實環境裡養一隻 AR 寵物',
    description: '用手機鏡頭把寵物召喚到桌上、地上：餵食、摸摸、培養親密度。飼料、寵物空位、新寵物可在商店購買。',
    url: 'https://wingfeeling.github.io/ar-pet/', buy_url: 'https://wingfeeling.github.io/ar-pet/',
    return_url: 'https://wingfeeling.github.io/ar-pet/', admin_url: 'https://wingfeeling.github.io/ar-pet/admin.html',
    hook_url: 'https://ar-pet-pay.wingfeeling.workers.dev/shop/hook', firebase_project: 'ar-pet-524e2',
    products: [
      ['food_5', '飼料 5 包', 10, { product: 'food_5' }, 'Credit', '餵寵物用的飼料 5 包。', '試吃包'],
      ['food_12', '飼料 12 包', 20, { product: 'food_12' }, 'Credit', '餵寵物用的飼料 12 包。', '多送 2 包'],
      ['food_45', '飼料 45 包', 64, { product: 'food_45' }, 'Credit', '餵寵物用的飼料 45 包。', '多送 5 包'],
      ['slot_1', '寵物空位 +1', 64, { product: 'slot_1' }, 'Credit', '多一個寵物空位，可以多養一隻。'],
      ...ARPET_PETS.flatMap(([k, label, d]) => [
        ['pet_' + k, label, 64, { product: 'pet_' + k }, 'Credit', `解鎖${label}：${d}。每個帳號買一次。`],
        ['set_' + k, label + '套餐', 128, { product: 'set_' + k }, 'Credit', `${label}＋1 個寵物空位＋10 包飼料。每個帳號買一次。`],
      ]),
    ] },
  { id: 'whisper', name: '語音轉文字', icon: '🎙️', sort: 30, mode: 'hub',
    tagline: '在自己的電腦裡把錄音轉成文字，不上傳',
    description: '瀏覽器裡執行的 Whisper 語音辨識，錄音和文字都不會上傳。付費版可以轉超過 1 小時的長檔案、詞庫不限、紀錄永久保留。',
    url: 'https://wingfeeling.github.io/whisper-web/', buy_url: 'https://wingfeeling.github.io/whisper-web/',
    return_url: 'https://wingfeeling.github.io/whisper-web/', admin_url: '', hook_url: '', firebase_project: 'pdf-editor-54ab7',
    products: [
      ['pro_m', '付費版 1 個月', 49, { pro_days: 31 }, 'Credit', '長檔案不限長度、詞庫不限、紀錄永久保留。'],
      ['pro_y', '付費版 1 年', 390, { pro_days: 366 }, 'ALL', '長檔案不限長度、詞庫不限、紀錄永久保留。平均每月約 33 元。'],
    ] },
];

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) schemaReady = (async () => {
    await env.DB.batch(SCHEMA.map(q => env.DB.prepare(q)));
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM services').first();
    if (!n.n) await seed(env);
  })().catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}
async function seed(env) {
  const t = now(), st = [];
  for (const s of SEED) {
    st.push(env.DB.prepare(`INSERT OR IGNORE INTO services (id, name, icon, tagline, description, url, buy_url, return_url, admin_url, firebase_project, mode, hook_url, secret, active, sort, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`).bind(s.id, s.name, s.icon, s.tagline, s.description, s.url, s.buy_url, s.return_url, s.admin_url, s.firebase_project, s.mode, s.hook_url, randHex(24), s.sort, t, t));
    s.products.forEach(([code, name, price, grant, pay, desc, tag], i) => st.push(env.DB.prepare(
      `INSERT OR IGNORE INTO products (sku, service_id, code, name, description, price, grant_json, pay, tag, active, sort, updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`)
      .bind(s.id + '.' + code, s.id, code, name, desc || '', price, JSON.stringify(grant), pay || 'ALL', tag || '', i * 10, t)));
  }
  await env.DB.batch(st);
}
async function setting(env, k, make) {
  const r = await env.DB.prepare('SELECT v FROM settings WHERE k = ?').bind(k).first();
  if (r) return r.v;
  if (!make) return null;
  const v = make();
  await env.DB.prepare('INSERT OR IGNORE INTO settings (k, v) VALUES (?, ?)').bind(k, v).run();
  return (await env.DB.prepare('SELECT v FROM settings WHERE k = ?').bind(k).first()).v;
}

/* ============================== 服務設定（快取 30 秒） ============================== */
let svcCache = null, svcCacheAt = 0;
async function services(env, fresh) {
  if (!fresh && svcCache && now() - svcCacheAt < 30000) return svcCache;
  const { results } = await env.DB.prepare('SELECT * FROM services ORDER BY sort, id').all();
  svcCache = results; svcCacheAt = now();
  return results;
}
async function serviceOf(env, id, { active = true } = {}) {
  const s = (await services(env)).find(x => x.id === String(id || ''));
  if (!s || (active && !s.active)) throw new ApiError(404, '找不到這個服務');
  return s;
}
const originOf = u => { try { return new URL(u).origin; } catch { return null; } };
async function allowedOrigins(env) {
  const set = new Set(String(env.EXTRA_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
  for (const s of await services(env)) for (const u of [s.url, s.buy_url, s.return_url, s.admin_url]) { const o = originOf(u); if (o) set.add(o); }
  return set;
}
async function corsHeaders(req, env) {
  const origin = req.headers.get('origin');
  const h = { vary: 'origin' };
  if (origin && (await allowedOrigins(env)).has(origin)) Object.assign(h, {
    'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '86400' });
  return h;
}

/* ============================== Firebase 登入憑證驗證（可以同時接受好幾個 Firebase 專案） ============================== */
let JWKS = null, JWKS_EXP = 0;
async function googleKeys(force) {
  if (!force && JWKS && JWKS_EXP > now()) return JWKS;
  const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  if (!r.ok) throw new ApiError(503, '暫時無法驗證登入，請稍後再試');
  const m = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  JWKS = (await r.json()).keys; JWKS_EXP = now() + (m ? +m[1] * 1000 : 3600000);
  return JWKS;
}
/** projects：這次接受哪些 Firebase 專案的登入 */
async function requireUser(req, projects) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) throw new ApiError(401, '請先登入', { need_login: true });
  const parts = m[1].trim().split('.');
  if (parts.length !== 3) throw new ApiError(401, '請重新登入');
  let head, c;
  try { head = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]))); c = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]))); }
  catch { throw new ApiError(401, '請重新登入'); }
  if (head.alg !== 'RS256') throw new ApiError(401, '請重新登入');
  let jwk = (await googleKeys()).find(k => k.kid === head.kid);
  if (!jwk) jwk = (await googleKeys(true)).find(k => k.kid === head.kid);
  if (!jwk) throw new ApiError(401, '登入已過期，請重新登入');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  const t = now() / 1000, pid = c.aud;
  if (!good || !projects.filter(Boolean).includes(pid) || c.iss !== 'https://securetoken.google.com/' + pid) throw new ApiError(401, '登入資訊不屬於這個網站，請重新登入');
  if (!(c.exp > t - 30) || !(c.iat < t + 300) || typeof c.sub !== 'string' || !c.sub || c.sub.length > 128) throw new ApiError(401, '登入已過期，請重新登入');
  return { uid: c.sub, project: pid, email: normEmail(c.email), email_verified: c.email_verified === true, name: cleanText(c.name, 60) };
}
const hubProject = env => env.HUB_FIREBASE_PROJECT || 'pdf-editor-54ab7';
async function allProjects(env) { return [hubProject(env), ...(await services(env)).map(s => s.firebase_project)]; }
const adminList = env => String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
async function requireAdmin(req, env) {
  const u = await requireUser(req, await allProjects(env));
  if (!adminList(env).length) throw new ApiError(403, '還沒設定管理員：請在 wrangler.toml 的 ADMIN_EMAILS 填你的 Google 帳號 Email');
  if (!u.email || !u.email_verified || !adminList(env).includes(u.email)) throw new ApiError(403, '這個帳號沒有管理權限');
  return u;
}

/* ============================== 綠界 ============================== */
// 從綠界後台複製貼上時常多帶空白、換行、全形空白或引號，會讓檢查碼對不上
const cleanSecret = v => String(v ?? '').replace(/[\s\u200b-\u200d\ufeff\u3000"'\u300c\u300d]/g, '');
function ecpayKeys(env) {
  const id = cleanSecret(env.ECPAY_MERCHANT_ID), key = cleanSecret(env.ECPAY_HASH_KEY), iv = cleanSecret(env.ECPAY_HASH_IV);
  if (!id || !key || !iv) throw new ApiError(503, '付款功能還沒設定好（綠界金鑰），請稍後再試');
  return { id, key, iv };
}
// .NET 的 UrlEncode 不會編碼 ! * ( )，綠界照 .NET 算，所以要轉回來
const fixDotNet = s => s.replace(/%21/g, '!').replace(/%2a/g, '*').replace(/%28/g, '(').replace(/%29/g, ')');
async function ecpayMac(params, key, iv) {
  const body = Object.keys(params).filter(k => k !== 'CheckMacValue')
    .sort((a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; })
    .map(k => `${k}=${params[k]}`).join('&');
  const s = fixDotNet(encodeURIComponent(`HashKey=${key}&${body}&HashIV=${iv}`).replace(/%20/g, '+').replace(/'/g, '%27').replace(/~/g, '%7e').toLowerCase());
  return (await sha256Hex(s)).toUpperCase();
}
// 訂單編號：W + yyMMddHHmmss + 7 碼亂數 = 20 碼
const newOrderNo = () => 'W' + twNow().replace(/\D/g, '').slice(2) + randHex(4).toUpperCase().slice(0, 7);
async function ecpayCheck(env) {
  let k;
  try { k = ecpayKeys(env); } catch { return { mode: isProd(env) ? 'production' : 'stage', result: 'missing' }; }
  const p = { MerchantID: k.id, MerchantTradeNo: 'CHK' + now(), TimeStamp: String(Math.floor(now() / 1000)) };
  p.CheckMacValue = await ecpayMac(p, k.key, k.iv);
  let t = '';
  try { t = await (await fetch(ecpayHost(env) + '/Cashier/QueryTradeInfo/V5', { method: 'POST', body: new URLSearchParams(p) })).text(); }
  catch { return { mode: isProd(env) ? 'production' : 'stage', result: 'unreachable' }; }
  const st = new URLSearchParams(t.replace(/^&/, '')).get('TradeStatus') || '';
  const result = { '10200047': 'ok', '10200073': 'badkey', '10200074': 'badmerchant', '10200094': 'badmerchant' }[st] || 'unknown';
  return { mode: isProd(env) ? 'production' : 'stage', result, code: st || t.replace(/CheckMacValue=\w+/, '').slice(0, 80) };
}

/* ============================== 結帳 ============================== */
const productOut = p => ({ sku: p.sku, code: p.code, service: p.service_id, name: p.name, description: p.description || '', price: p.price, pay: p.pay, tag: p.tag || '', sort: p.sort });
async function productsOf(env, serviceId, all) {
  const { results } = await env.DB.prepare(`SELECT * FROM products WHERE service_id = ? ${all ? '' : 'AND active = 1'} ORDER BY sort, sku`).bind(serviceId).all();
  return results;
}
async function sessionKey(env) { return setting(env, 'session_secret', () => randHex(32)); }
async function makeSession(env, data) {
  const body = b64url(enc.encode(JSON.stringify({ ...data, exp: now() + 2 * 3600e3 })));
  return body + '.' + await hmacHex(await sessionKey(env), body);
}
async function readSession(env, s) {
  const [body, sig] = String(s || '').split('.');
  if (!body || !sig || !safeEq(sig, await hmacHex(await sessionKey(env), body))) throw new ApiError(400, '結帳連結不正確，請回到原本的網站重新按「購買」');
  const d = parseJ(new TextDecoder().decode(fromB64url(body)), null);
  if (!d || !(d.exp > now())) throw new ApiError(400, '結帳連結已經過期，請回到原本的網站重新按「購買」');
  return d;
}
async function checkoutStart(req, env, url) {
  const x = await readJson(req);
  const svc = await serviceOf(env, x.service);
  const u = await requireUser(req, [svc.firebase_project]);
  let sku = x.sku ? String(x.sku) : '';
  if (sku && !sku.includes('.')) sku = svc.id + '.' + sku;
  if (sku) { const p = await env.DB.prepare('SELECT sku FROM products WHERE sku = ? AND service_id = ? AND active = 1').bind(sku, svc.id).first(); if (!p) throw new ApiError(404, '沒有這個商品，請重新整理頁面'); }
  const s = await makeSession(env, { svc: svc.id, prj: u.project, uid: u.uid, em: u.email, nm: u.name, sku });
  return { url: url.origin + '/pay.html?s=' + encodeURIComponent(s) };
}
async function checkoutSession(env, url) {
  const d = await readSession(env, url.searchParams.get('s'));
  const svc = await serviceOf(env, d.svc);
  return { service: { id: svc.id, name: svc.name, icon: svc.icon, url: svc.url, tagline: svc.tagline }, email: d.em, sku: d.sku || '',
    products: (await productsOf(env, svc.id)).map(productOut), mode: isProd(env) ? 'production' : 'stage', store: storeName(env) };
}
/** 叫服務的 hook（簽章：x-shop-sig = HMAC-SHA256(secret, 時間戳 + '.' + 內容)） */
async function callHook(svc, payload) {
  if (!svc.hook_url) throw new Error('這個服務沒有設定 hook 網址');
  const body = JSON.stringify(payload), ts = String(Math.floor(now() / 1000));
  const r = await fetch(svc.hook_url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shop-ts': ts, 'x-shop-sig': await hmacHex(svc.secret, ts + '.' + body) }, body });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d && (d.message || d.error)) || ('HTTP ' + r.status));
  return d;
}
async function checkoutPay(req, env, url) {
  const x = await readJson(req);
  const d = await readSession(env, x.s);
  const svc = await serviceOf(env, d.svc);
  if (x.agree !== true) throw new ApiError(400, '請先勾選同意購買須知');
  const p = await env.DB.prepare('SELECT * FROM products WHERE sku = ? AND service_id = ? AND active = 1').bind(String(x.sku || ''), svc.id).first();
  if (!p || !(p.price > 0)) throw new ApiError(404, '沒有這個商品，請重新整理頁面');
  // 先問服務「這個人可以買嗎」（例如 AR 寵物：已經擁有的寵物不能再買）
  if (svc.mode === 'webhook') {
    let r;
    try { r = await callHook(svc, { type: 'check', uid: d.uid, project: d.prj, email: d.em, sku: p.sku, code: p.code, grant: parseJ(p.grant_json, {}) }); }
    catch (e) { console.warn('check hook', svc.id, e.message); throw new ApiError(503, `暫時連不上「${svc.name}」，請稍後再試`); }
    if (r && r.ok === false) throw new ApiError(409, r.message || '這個商品現在不能購買');
  }
  const k = ecpayKeys(env);
  const no = newOrderNo();
  await env.DB.prepare(`INSERT INTO orders (no, service_id, sku, code, product_name, amount, grant_json, project, uid, email, name, status, fulfill, mode, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'created', 'pending', ?, ?)`)
    .bind(no, svc.id, p.sku, p.code, p.name, p.price, p.grant_json || '{}', d.prj, d.uid, d.em, d.nm || '', isProd(env) ? 'production' : 'stage', now()).run();
  const back = svc.return_url ? addQuery(svc.return_url, 'order', no) : url.origin + '/thanks.html?order=' + no;
  const f = {
    MerchantID: k.id, MerchantTradeNo: no, MerchantTradeDate: twNow(), PaymentType: 'aio', TotalAmount: String(p.price),
    TradeDesc: storeName(env).replace(/[#&]/g, ' ').slice(0, 50), ItemName: `${svc.name} ${p.name}`.replace(/[#&]/g, ' ').slice(0, 200),
    ReturnURL: url.origin + '/api/ecpay/notify', OrderResultURL: url.origin + '/api/ecpay/result', ClientBackURL: back,
    ChoosePayment: p.pay === 'Credit' ? 'Credit' : 'ALL', EncryptType: '1', CustomField1: svc.id, NeedExtraPaidInfo: 'N',
  };
  if (f.ChoosePayment === 'ALL') {
    // ATM 每筆最低約 15 元手續費、超商代碼／條碼每筆固定費用，小額不划算
    const small = p.price < intOr(env.ATM_MIN_AMOUNT, 600);
    f.IgnorePayment = small ? 'ATM#CVS#BARCODE#WebATM' : (env.ECPAY_IGNORE_PAYMENT || 'CVS#BARCODE#WebATM');
  }
  f.CheckMacValue = await ecpayMac(f, k.key, k.iv);
  return { order: no, action: ecpayHost(env) + '/Cashier/AioCheckOut/V5', params: f };
}
function addQuery(u, k, v) { try { const x = new URL(u); x.searchParams.set(k, v); return x.toString(); } catch { return u; } }

async function ecpayNotify(req, env, ctx) {
  const plain = (s, st = 200) => new Response(s, { status: st, headers: { 'content-type': 'text/plain' } });
  try {
    const k = ecpayKeys(env);
    const b = {}; for (const [kk, v] of (await req.formData()).entries()) b[kk] = String(v);
    if (!safeEq(String(b.CheckMacValue || '').toUpperCase(), await ecpayMac(b, k.key, k.iv))) { console.warn('ecpay CheckMacValue 不符', b.MerchantTradeNo); return plain('0|CheckMacValue Error', 400); }
    if (b.MerchantID !== k.id) return plain('0|MerchantID Error', 400);
    const o = await env.DB.prepare('SELECT * FROM orders WHERE no = ?').bind(String(b.MerchantTradeNo || '')).first();
    if (!o) return plain('0|Order Not Found', 400);
    if (o.status === 'paid' || o.status === 'refunded') return plain('1|OK');           // 綠界可能重送通知：處理過就不要再出貨一次
    const rtn = String(b.RtnCode), info = [b.TradeNo || '', b.PaymentType || '', rtn, cleanText(b.RtnMsg, 200), now()];
    const simulated = String(b.SimulatePaid) === '1';
    if (rtn === '1') {
      let status = 'paid';
      if (+b.TradeAmt !== +o.amount) status = 'amount_mismatch';
      else if (simulated && isProd(env)) status = 'simulated';                           // 綠界後台「模擬付款」：正式環境不出貨
      const r = await env.DB.prepare(`UPDATE orders SET status = ?, ecpay_trade_no = ?, payment_type = ?, rtn_code = ?, rtn_msg = ?, notified_at = ?, paid_at = CASE WHEN ? = 'paid' THEN ? ELSE paid_at END
        WHERE no = ? AND status NOT IN ('paid', 'refunded')`).bind(status, ...info, status, now(), o.no).run();
      if (r.meta.changes && status === 'paid') ctx.waitUntil(fulfill(env, o.no).catch(e => console.error('fulfill', o.no, e)));
    } else if (['2', '800', '10100073'].includes(rtn)) {
      await env.DB.prepare(`UPDATE orders SET status = 'waiting', ecpay_trade_no = ?, payment_type = ?, rtn_code = ?, rtn_msg = ?, notified_at = ? WHERE no = ? AND status IN ('created', 'waiting')`).bind(...info, o.no).run();
    } else {
      await env.DB.prepare(`UPDATE orders SET status = 'failed', ecpay_trade_no = ?, payment_type = ?, rtn_code = ?, rtn_msg = ?, notified_at = ? WHERE no = ? AND status IN ('created', 'waiting')`).bind(...info, o.no).run();
    }
    return plain('1|OK');
  } catch (e) {
    console.error('ecpayNotify', e && e.stack || e);
    return plain('0|' + (e.message || 'error'), 500);                                   // 回錯誤，綠界會再重送
  }
}
async function ecpayResult(req, env, url) {
  let no = url.searchParams.get('order') || '';
  if (req.method === 'POST') { try { no = String((await req.formData()).get('MerchantTradeNo') || no); } catch {} }
  no = no.replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
  const o = no && await env.DB.prepare('SELECT service_id FROM orders WHERE no = ?').bind(no).first();
  const svc = o && (await services(env)).find(s => s.id === o.service_id);
  const to = svc && svc.return_url ? addQuery(svc.return_url, 'order', no) : url.origin + '/thanks.html' + (no ? '?order=' + no : '');
  return new Response(`<meta http-equiv="refresh" content="0;url=${to.replace(/"/g, '&quot;')}">`, { status: 303, headers: { location: to, 'content-type': 'text/html; charset=utf-8' } });
}

/* ============================== 出貨 ============================== */
async function fulfill(env, no) {
  const o = await env.DB.prepare('SELECT * FROM orders WHERE no = ?').bind(no).first();
  if (!o || o.status !== 'paid' || o.fulfill === 'done') return { ok: true, skipped: true };
  const svc = (await services(env, true)).find(s => s.id === o.service_id);
  const grant = parseJ(o.grant_json, {});
  try {
    if (!svc) throw new Error('找不到服務 ' + o.service_id);
    if (svc.mode === 'hub') await grantHub(env, o, grant, 1);
    else {
      const r = await callHook(svc, { type: 'paid', order: orderHookOut(o), grant });
      if (!r || r.ok !== true) throw new Error((r && r.message) || '服務沒有回覆 ok');
    }
    await env.DB.prepare("UPDATE orders SET fulfill = 'done', fulfill_at = ?, fulfill_error = NULL, fulfill_tries = fulfill_tries + 1 WHERE no = ?").bind(now(), no).run();
    return { ok: true };
  } catch (e) {
    await env.DB.prepare("UPDATE orders SET fulfill = 'failed', fulfill_error = ?, fulfill_tries = fulfill_tries + 1 WHERE no = ?").bind(String(e.message || e).slice(0, 300), no).run();
    return { ok: false, error: String(e.message || e) };
  }
}
const orderHookOut = o => ({ no: o.no, sku: o.sku, code: o.code, name: o.product_name, amount: o.amount, uid: o.uid, project: o.project, email: o.email,
  status: o.status, payment_type: o.payment_type, paid_at: o.paid_at, created_at: o.created_at, mode: o.mode });
/** mode 'hub' 的服務：總店自己記權限。sign = 1 加上、-1 收回（退款） */
async function grantHub(env, o, grant, sign) {
  const days = Math.max(0, intOr(grant.pro_days, 0)), life = grant.lifetime ? 1 : 0, t = now();
  if (sign > 0) {
    await env.DB.prepare(`INSERT INTO entitlements (service_id, project, uid, email, pro_until, lifetime, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(service_id, project, uid) DO UPDATE SET email = ?4, pro_until = MAX(COALESCE(pro_until, 0), ?7) + ?8, lifetime = MAX(lifetime, ?6), updated_at = ?7`)
      .bind(o.service_id, o.project, o.uid, o.email, t + days * DAY, life, t, days * DAY).run();
  } else {
    await env.DB.prepare(`UPDATE entitlements SET pro_until = MAX(0, COALESCE(pro_until, 0) - ?), lifetime = CASE WHEN ? THEN 0 ELSE lifetime END, updated_at = ? WHERE service_id = ? AND project = ? AND uid = ?`)
      .bind(days * DAY, life, t, o.service_id, o.project, o.uid).run();
  }
}
async function entitlementOf(env, serviceId, project, uid) {
  const e = await env.DB.prepare('SELECT * FROM entitlements WHERE service_id = ? AND project = ? AND uid = ?').bind(serviceId, project, uid).first();
  const pro = !!e && (e.lifetime === 1 || (e.pro_until || 0) > now());
  return { plan: pro ? 'pro' : 'free', pro_until: e && e.pro_until ? e.pro_until : null, lifetime: !!(e && e.lifetime) };
}

/* ============================== 客服・許願池（所有服務共用） ============================== */
const SUPPORT = { maxText: 2000, maxReply: 1000, maxImages: 3, maxImageChars: 900000, perDay: 10, maxThread: 40 };
const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const TID_RE = /^T[\w:-]{4,90}$/;
// 給使用者看的樣子：同時給 camelCase 和 snake_case，各網站原本的畫面都看得懂
function ticketOut(t) {
  const thread = parseJ(t.thread, []).map(m => ({ by: m.by, text: m.text, at: typeof m.at === 'number' ? iso(m.at) : m.at }));
  return { id: t.id, service: t.service_id, type: t.type, text: t.text, price: t.price ?? null, status: t.status, thread,
    imageCount: t.image_count || 0, image_count: t.image_count || 0, userUnread: !!t.user_unread, user_unread: !!t.user_unread,
    createdAt: iso(t.created_at), created_at: t.created_at, updatedAt: iso(t.updated_at), updated_at: t.updated_at };
}
async function support(action, req, env) {
  const x = await readJson(req);
  const svc = await serviceOf(env, x.service, { active: false });
  const u = await requireUser(req, [svc.firebase_project, hubProject(env)]);
  const mine = id => env.DB.prepare('SELECT * FROM tickets WHERE id = ? AND project = ? AND uid = ?').bind(String(id || ''), u.project, u.uid).first();
  if (action === 'create') {
    const type = String(x.type || '');
    if (!['bug', 'wish'].includes(type)) throw new ApiError(400, '訊息種類不對');
    const text = cleanText(x.text, SUPPORT.maxText);
    if (text.length < 2) throw new ApiError(400, type === 'wish' ? '請寫下你的願望' : '請描述遇到的問題');
    let price = null;
    if (type === 'wish' && x.price !== null && x.price !== undefined && x.price !== '') {
      price = Math.round(Number(x.price));
      if (!(price >= 0 && price <= 100000)) throw new ApiError(400, '金額請填 0～100000 之間的數字');
    }
    const images = type === 'bug' && Array.isArray(x.images) ? x.images : [];
    if (images.length > SUPPORT.maxImages) throw new ApiError(400, `截圖最多 ${SUPPORT.maxImages} 張`);
    for (const im of images) if (typeof im !== 'string' || im.length > SUPPORT.maxImageChars || !IMG_RE.test(im)) throw new ApiError(400, '截圖格式不對或太大，請換一張');
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM tickets WHERE project = ? AND uid = ? AND created_at > ?').bind(u.project, u.uid, now() - DAY).first();
    if (c.n >= SUPPORT.perDay) throw new ApiError(429, `24 小時內最多送出 ${SUPPORT.perDay} 則訊息，請明天再試，或在之前的訊息裡補充`);
    const id = 'T' + svc.id + '-' + randHex(6), t = now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO tickets (id, service_id, project, uid, email, name, type, text, price, device, image_count, status, thread, user_unread, admin_unread, source, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, 'open', '[]', 0, 1, 'hub', ?, ?)`).bind(id, svc.id, u.project, u.uid, u.email, u.name, type, text, price, cleanText(x.device, 300), images.length, t, t),
      ...images.map((data, n) => env.DB.prepare('INSERT INTO ticket_images (ticket_id, n, data) VALUES (?,?,?)').bind(id, n, data)),
    ]);
    return { ok: true, id };
  }
  if (action === 'mine') {
    const all = x.all === true;   // 總店的客服頁：看自己在所有服務的訊息
    const { results } = await env.DB.prepare(`SELECT * FROM tickets WHERE project = ? AND uid = ? ${all ? '' : 'AND service_id = ?'} ORDER BY created_at DESC LIMIT 200`)
      .bind(u.project, u.uid, ...(all ? [] : [svc.id])).all();
    return { tickets: results.map(ticketOut) };
  }
  if (action === 'image') {
    const t = await mine(x.id); if (!t) throw new ApiError(404, '找不到這張截圖');
    const img = await env.DB.prepare('SELECT data FROM ticket_images WHERE ticket_id = ? AND n = ?').bind(t.id, intOr(x.n, -1)).first();
    if (!img) throw new ApiError(404, '找不到這張截圖');
    return { data: img.data };
  }
  if (action === 'followup') {
    const text = cleanText(x.text, SUPPORT.maxReply); if (!text) throw new ApiError(400, '請輸入內容');
    const t = await mine(x.id); if (!t) throw new ApiError(404, '找不到這則訊息');
    if (t.status === 'closed') throw new ApiError(400, '這則訊息已經結案了，有新的問題請重新送出一則');
    const th = parseJ(t.thread, []); if (th.length >= SUPPORT.maxThread) throw new ApiError(400, '這則訊息的對話太長了，請重新送出一則');
    th.push({ by: 'user', text, at: now() });
    await env.DB.prepare("UPDATE tickets SET thread = ?, status = 'open', admin_unread = 1, updated_at = ? WHERE id = ?").bind(JSON.stringify(th), now(), t.id).run();
    return { ok: true };
  }
  if (action === 'read') {
    const ids = (Array.isArray(x.ids) ? x.ids : []).slice(0, 50).map(String).filter(id => TID_RE.test(id));
    if (ids.length) await env.DB.batch(ids.map(id => env.DB.prepare('UPDATE tickets SET user_unread = 0 WHERE id = ? AND project = ? AND uid = ?').bind(id, u.project, u.uid)));
    return { ok: true, n: ids.length };
  }
  if (action === 'deleteMine') {   // 刪除帳號時一起刪掉自己的訊息和截圖
    const { results } = await env.DB.prepare('SELECT id FROM tickets WHERE project = ? AND uid = ?').bind(u.project, u.uid).all();
    const st = results.flatMap(t => [env.DB.prepare('DELETE FROM ticket_images WHERE ticket_id = ?').bind(t.id), env.DB.prepare('DELETE FROM tickets WHERE id = ?').bind(t.id)]);
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    return { ok: true, n: results.length };
  }
  throw new ApiError(404, '沒有這個功能');
}

/* ============================== 管理後台 ============================== */
const svcAdminOut = s => ({ ...s, active: !!s.active });
const orderAdminOut = o => ({ ...o, grant: parseJ(o.grant_json, {}), grant_json: undefined });
async function log(env, by, action, ref, note) {
  await env.DB.prepare('INSERT INTO admin_log (by_email, action, ref, note, at) VALUES (?,?,?,?,?)').bind(by, action, String(ref || ''), String(note || '').slice(0, 300), now()).run();
}
async function admin(action, req, env) {
  const me = await requireAdmin(req, env);
  const x = await readJson(req), DB = env.DB;
  if (action === 'summary') {
    const ms = twMonthStart();
    const [sales, unread, failed, waiting, recent] = await Promise.all([
      DB.prepare("SELECT service_id, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM orders WHERE status = 'paid' AND paid_at >= ? AND mode = ? GROUP BY service_id").bind(ms, isProd(env) ? 'production' : 'stage').all(),
      DB.prepare('SELECT service_id, type, COUNT(*) AS n FROM tickets WHERE admin_unread = 1 GROUP BY service_id, type').all(),
      DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' AND fulfill = 'failed'").first(),
      DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'waiting'").first(),
      DB.prepare("SELECT * FROM orders WHERE status != 'created' ORDER BY created_at DESC LIMIT 10").all(),
    ]);
    return { me: me.email, mode: isProd(env) ? 'production' : 'stage', store: storeName(env), services: (await services(env, true)).map(s => ({ id: s.id, name: s.name, icon: s.icon, active: !!s.active, mode: s.mode, admin_url: s.admin_url, url: s.url })),
      sales: sales.results, unread: unread.results, fulfill_failed: failed.n, waiting: waiting.n, recent: recent.results.map(orderAdminOut) };
  }
  if (action === 'ecpay-check') return ecpayCheck(env);

  /* ---------- 訂單 ---------- */
  if (action === 'orders') {
    const w = [], a = [];
    if (x.service) { w.push('service_id = ?'); a.push(String(x.service)); }
    if (x.status === 'problem') w.push("((status = 'paid' AND fulfill = 'failed') OR status IN ('amount_mismatch', 'simulated'))");
    else if (x.status === 'all') {} else if (x.status) { w.push('status = ?'); a.push(String(x.status)); }
    else w.push("(status != 'created' OR created_at > " + (now() - 2 * DAY) + ')');
    if (x.q) { w.push('(email LIKE ? OR no LIKE ? OR uid = ?)'); const q = '%' + String(x.q).trim().toLowerCase() + '%'; a.push(q, '%' + String(x.q).trim().toUpperCase() + '%', String(x.q).trim()); }
    if (x.env === 'cur') { w.push('mode = ?'); a.push(isProd(env) ? 'production' : 'stage'); }
    const { results } = await DB.prepare(`SELECT * FROM orders ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 300`).bind(...a).all();
    return { orders: results.map(orderAdminOut) };
  }
  if (action === 'refulfill') {
    const o = await DB.prepare("SELECT * FROM orders WHERE no = ? AND status = 'paid'").bind(String(x.no || '')).first();
    if (!o) throw new ApiError(404, '找不到這筆已付款的訂單');
    await DB.prepare("UPDATE orders SET fulfill = 'pending' WHERE no = ?").bind(o.no).run();
    const r = await fulfill(env, o.no); await log(env, me.email, 'refulfill', o.no, r.ok ? 'ok' : r.error);
    if (!r.ok) throw new ApiError(502, '出貨失敗：' + r.error);
    return { ok: true };
  }
  if (action === 'mark-paid') {   // ATM 轉帳、匯款等：在綠界後台確認有入帳，但通知沒進來時手動補
    const o = await DB.prepare("SELECT * FROM orders WHERE no = ? AND status IN ('created', 'waiting', 'failed', 'amount_mismatch')").bind(String(x.no || '')).first();
    if (!o) throw new ApiError(404, '找不到這筆未付款的訂單');
    await DB.prepare("UPDATE orders SET status = 'paid', paid_at = ?, fulfill = 'pending', note = ? WHERE no = ?").bind(now(), ('手動標記已付款 by ' + me.email + '：' + cleanText(x.note, 150)).slice(0, 300), o.no).run();
    const r = await fulfill(env, o.no); await log(env, me.email, 'mark-paid', o.no, x.note);
    return { ok: true, fulfill: r };
  }
  if (action === 'refund') {      // 先在綠界後台退款，再到這裡標記：收回這筆訂單給的東西
    const o = await DB.prepare("SELECT * FROM orders WHERE no = ? AND status = 'paid'").bind(String(x.no || '')).first();
    if (!o) throw new ApiError(404, '找不到這筆已付款的訂單');
    const svc = (await services(env, true)).find(s => s.id === o.service_id);
    let revoked = 'skip', err = '';
    if (x.revoke !== false && o.fulfill === 'done') {
      try {
        if (svc && svc.mode === 'hub') { await grantHub(env, o, parseJ(o.grant_json, {}), -1); revoked = 'ok'; }
        else if (svc) { const r = await callHook(svc, { type: 'refund', order: orderHookOut(o), grant: parseJ(o.grant_json, {}) }); revoked = r && r.ok ? 'ok' : 'failed'; err = (r && r.message) || ''; }
      } catch (e) { revoked = 'failed'; err = e.message; }
    }
    await DB.prepare("UPDATE orders SET status = 'refunded', refunded_at = ?, note = ? WHERE no = ?").bind(now(), (`退款 by ${me.email}：${cleanText(x.note, 120)}${revoked === 'failed' ? `（收回失敗：${err}）` : ''}`).slice(0, 300), o.no).run();
    await log(env, me.email, 'refund', o.no, x.note);
    return { ok: true, revoked, error: err };
  }

  /* ---------- 客服・許願池 ---------- */
  if (action === 'tickets') {
    const w = [], a = [];
    if (x.service) { w.push('service_id = ?'); a.push(String(x.service)); }
    if (['bug', 'wish'].includes(x.type)) { w.push('type = ?'); a.push(x.type); }
    if (x.status === 'unread') w.push('admin_unread = 1'); else if (['open', 'replied', 'closed'].includes(x.status)) { w.push('status = ?'); a.push(x.status); }
    if (x.q) { w.push('(email LIKE ? OR text LIKE ?)'); a.push('%' + String(x.q).trim() + '%', '%' + String(x.q).trim() + '%'); }
    const { results } = await DB.prepare(`SELECT * FROM tickets ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT 400`).bind(...a).all();
    return { tickets: results.map(t => ({ ...ticketOut(t), uid: t.uid, project: t.project, email: t.email, name: t.name, device: t.device, source: t.source, admin_unread: !!t.admin_unread })) };
  }
  if (action === 'ticket-image') {
    const img = await DB.prepare('SELECT data FROM ticket_images WHERE ticket_id = ? AND n = ?').bind(String(x.id || ''), intOr(x.n, -1)).first();
    if (!img) throw new ApiError(404, '找不到這張截圖');
    return { data: img.data };
  }
  if (action === 'ticket') {      // 回覆／改狀態／標記已讀
    const t = await DB.prepare('SELECT * FROM tickets WHERE id = ?').bind(String(x.id || '')).first();
    if (!t) throw new ApiError(404, '找不到這則訊息');
    const text = cleanText(x.text, SUPPORT.maxReply), th = parseJ(t.thread, []);
    let status = x.status || t.status; if (text && !x.status) status = 'replied';
    if (text && x.close) status = 'closed';
    if (!['open', 'replied', 'closed'].includes(status)) throw new ApiError(400, '狀態不對');
    if (text) th.push({ by: 'admin', text, at: now() });
    await DB.prepare('UPDATE tickets SET thread = ?, status = ?, admin_unread = 0, user_unread = CASE WHEN ? THEN 1 ELSE user_unread END, updated_at = CASE WHEN ? THEN ? ELSE updated_at END WHERE id = ?')
      .bind(JSON.stringify(th), status, text ? 1 : 0, text || x.status ? 1 : 0, now(), t.id).run();
    if (text || x.status) await log(env, me.email, text ? 'reply' : 'ticket_' + status, t.id, '');
    return { ok: true };
  }
  if (action === 'ticket-delete') {
    await DB.batch([DB.prepare('DELETE FROM ticket_images WHERE ticket_id = ?').bind(String(x.id || '')), DB.prepare('DELETE FROM tickets WHERE id = ?').bind(String(x.id || ''))]);
    await log(env, me.email, 'ticket_delete', x.id, ''); return { ok: true };
  }
  /* 把服務舊的客服・許願池訊息搬進總店：一次一頁，後台一直呼叫到 next 是 null 為止。已經搬過的不會重複 */
  if (action === 'import-tickets') {
    const svc = await serviceOf(env, x.service, { active: false });
    if (svc.mode !== 'webhook') throw new ApiError(400, '這個服務沒有舊的訊息可以搬');
    let r;
    try { r = await callHook(svc, { type: 'export_tickets', cursor: x.cursor || null }); }
    catch (e) { throw new ApiError(502, `連不上「${svc.name}」：${e.message}`); }
    const list = Array.isArray(r.tickets) ? r.tickets : [], st = [];
    for (const t of list) {
      const id = 'T' + svc.id + ':' + String(t.id || '').replace(/[^\w-]/g, '').slice(0, 60);
      if (id.length < 6 || !t.uid) continue;
      const imgs = (Array.isArray(t.images) ? t.images : []).filter(im => typeof im === 'string' && IMG_RE.test(im) && im.length <= SUPPORT.maxImageChars).slice(0, SUPPORT.maxImages);
      const ms = v => typeof v === 'number' ? v : (Date.parse(v) || now());
      const thread = (Array.isArray(t.thread) ? t.thread : []).slice(0, SUPPORT.maxThread).map(m => ({ by: m.by === 'admin' ? 'admin' : 'user', text: cleanText(m.text, SUPPORT.maxReply), at: ms(m.at) }));
      st.push(DB.prepare(`INSERT OR IGNORE INTO tickets (id, service_id, project, uid, email, name, type, text, price, device, image_count, status, thread, user_unread, admin_unread, source, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'import', ?, ?)`).bind(id, svc.id, svc.firebase_project, String(t.uid).slice(0, 128), normEmail(t.email), cleanText(t.name, 60),
        t.type === 'wish' ? 'wish' : 'bug', cleanText(t.text, SUPPORT.maxText), t.price == null ? null : intOr(t.price, null), cleanText(t.device, 300), imgs.length,
        ['open', 'replied', 'closed'].includes(t.status) ? t.status : 'open', JSON.stringify(thread), t.user_unread ? 1 : 0, t.admin_unread ? 1 : 0, ms(t.created_at), ms(t.updated_at || t.created_at)));
      imgs.forEach((data, n) => st.push(DB.prepare('INSERT OR IGNORE INTO ticket_images (ticket_id, n, data) VALUES (?,?,?)').bind(id, n, data)));
    }
    for (let i = 0; i < st.length; i += 50) await DB.batch(st.slice(i, i + 50));
    if (!r.next) await log(env, me.email, 'import_tickets', svc.id, '');
    return { ok: true, got: list.length, next: r.next || null };
  }

  /* ---------- 服務與商品 ---------- */
  if (action === 'services') {
    const svcs = await services(env, true);
    const { results } = await DB.prepare('SELECT * FROM products ORDER BY service_id, sort, sku').all();
    return { services: svcs.map(svcAdminOut), products: results.map(p => ({ ...p, active: !!p.active })), hub_project: hubProject(env), origin: new URL(req.url).origin };
  }
  if (action === 'service-save') {
    const id = String(x.id || '').trim().toLowerCase();
    if (!SLUG_RE.test(id)) throw new ApiError(400, '服務代號只能用英文小寫、數字、減號，2～24 個字，第一個字要是英文');
    const name = cleanText(x.name, 60); if (!name) throw new ApiError(400, '請填服務名稱');
    const mode = x.mode === 'webhook' ? 'webhook' : 'hub';
    const url = v => { const s = String(v || '').trim(); if (!s) return ''; if (!/^https:\/\/[^\s]+$/.test(s)) throw new ApiError(400, '網址要用 https:// 開頭：' + s); return s.slice(0, 300); };
    const f = [name, cleanText(x.icon, 8), cleanText(x.tagline, 100), cleanText(x.description, 600), url(x.url), url(x.buy_url), url(x.return_url), url(x.admin_url),
      cleanText(x.firebase_project, 80), mode, url(x.hook_url), x.active === false ? 0 : 1, intOr(x.sort, 100), now()];
    if (!f[8]) throw new ApiError(400, '請填這個服務用的 Firebase 專案 ID（登入用）');
    if (mode === 'webhook' && !f[10]) throw new ApiError(400, '「通知網站出貨」要填 hook 網址');
    const old = await DB.prepare('SELECT id FROM services WHERE id = ?').bind(id).first();
    if (old) await DB.prepare('UPDATE services SET name=?, icon=?, tagline=?, description=?, url=?, buy_url=?, return_url=?, admin_url=?, firebase_project=?, mode=?, hook_url=?, active=?, sort=?, updated_at=? WHERE id = ?').bind(...f, id).run();
    else await DB.prepare('INSERT INTO services (name, icon, tagline, description, url, buy_url, return_url, admin_url, firebase_project, mode, hook_url, active, sort, updated_at, id, secret, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(...f, id, randHex(24), now()).run();
    svcCache = null; await log(env, me.email, old ? 'service_update' : 'service_add', id, '');
    return { ok: true, created: !old };
  }
  if (action === 'service-secret') {   // 重新產生 hook 密碼（舊的會馬上失效）
    const s = await serviceOf(env, x.id, { active: false });
    await DB.prepare('UPDATE services SET secret = ? WHERE id = ?').bind(randHex(24), s.id).run();
    svcCache = null; await log(env, me.email, 'service_secret', s.id, ''); return { ok: true };
  }
  if (action === 'hook-test') {
    const s = await serviceOf(env, x.id, { active: false });
    try { const r = await callHook(s, { type: 'ping' }); return { ok: !!(r && r.ok), reply: r }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  if (action === 'product-save') {
    const s = await serviceOf(env, x.service, { active: false });
    const code = String(x.code || '').trim();
    if (!CODE_RE.test(code)) throw new ApiError(400, '商品代號只能用英文、數字、底線、減號（最多 40 個字）');
    const name = cleanText(x.name, 80); if (!name) throw new ApiError(400, '請填商品名稱');
    const price = intOr(x.price, 0); if (!(price >= 1 && price <= 200000)) throw new ApiError(400, '價格要在 1～200000 元之間');
    let grant = x.grant;
    if (typeof grant === 'string') { grant = parseJ(grant, null); if (!grant) throw new ApiError(400, '「付款後給什麼」要是 JSON 格式，例如 {"pro_days":31}'); }
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) throw new ApiError(400, '請填「付款後給什麼」');
    const sku = s.id + '.' + code;
    await DB.prepare(`INSERT INTO products (sku, service_id, code, name, description, price, grant_json, pay, tag, active, sort, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
      ON CONFLICT(sku) DO UPDATE SET name=?4, description=?5, price=?6, grant_json=?7, pay=?8, tag=?9, active=?10, sort=?11, updated_at=?12`)
      .bind(sku, s.id, code, name, cleanText(x.description, 500), price, JSON.stringify(grant), x.pay === 'Credit' ? 'Credit' : 'ALL', cleanText(x.tag, 20), x.active === false ? 0 : 1, intOr(x.sort, 100), now()).run();
    await log(env, me.email, 'product_save', sku, `NT$${price}`); return { ok: true, sku };
  }

  /* ---------- 權限（mode 'hub' 的服務：總店自己記的付費版） ---------- */
  if (action === 'entitlements') {
    const w = [], a = [];
    if (x.service) { w.push('service_id = ?'); a.push(String(x.service)); }
    if (x.q) { w.push('(email LIKE ? OR uid = ?)'); a.push('%' + String(x.q).trim().toLowerCase() + '%', String(x.q).trim()); }
    const { results } = await DB.prepare(`SELECT * FROM entitlements ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT 300`).bind(...a).all();
    return { entitlements: results.map(e => ({ ...e, pro: e.lifetime === 1 || (e.pro_until || 0) > now() })) };
  }
  if (action === 'entitlement-set') {   // 手動開通／收回：要知道對方的帳號（用 Email 找他買過的訂單或已有的權限）
    const s = await serviceOf(env, x.service, { active: false });
    if (s.mode !== 'hub') throw new ApiError(400, `「${s.name}」的權限記在它自己的網站，請到它的管理後台處理`);
    let { project, uid } = x; const email = normEmail(x.email);
    if (!uid && email) {
      const hit = await DB.prepare('SELECT project, uid FROM entitlements WHERE service_id = ? AND email = ? LIMIT 1').bind(s.id, email).first()
        || await DB.prepare('SELECT project, uid FROM orders WHERE service_id = ? AND email = ? ORDER BY created_at DESC LIMIT 1').bind(s.id, email).first()
        || await DB.prepare('SELECT project, uid FROM tickets WHERE email = ? AND project = ? ORDER BY created_at DESC LIMIT 1').bind(email, s.firebase_project).first();
      if (!hit) throw new ApiError(404, '找不到這個 Email。請對方先登入後按一次「升級付費版」或在客服留言，就查得到了');
      ({ project, uid } = hit);
    }
    if (!uid || !project) throw new ApiError(400, '請輸入 Email');
    const days = intOr(x.add_days, 0), t = now();
    const cur = await DB.prepare('SELECT * FROM entitlements WHERE service_id = ? AND project = ? AND uid = ?').bind(s.id, project, uid).first();
    const until = x.pro_until !== undefined && x.pro_until !== null && x.pro_until !== '' ? intOr(x.pro_until, 0) : Math.max(cur?.pro_until || 0, t) + days * DAY;
    const life = x.lifetime === undefined ? (cur?.lifetime || 0) : (x.lifetime ? 1 : 0);
    await DB.prepare(`INSERT INTO entitlements (service_id, project, uid, email, pro_until, lifetime, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)
      ON CONFLICT(service_id, project, uid) DO UPDATE SET email = COALESCE(NULLIF(?4, ''), email), pro_until = ?5, lifetime = ?6, updated_at = ?7`).bind(s.id, project, uid, email || cur?.email || '', until, life, t).run();
    await log(env, me.email, 'entitlement_set', `${s.id}:${uid}`, `${days ? '+' + days + '天 ' : ''}${cleanText(x.note, 150)}`);
    return { ok: true, entitlement: await entitlementOf(env, s.id, project, uid) };
  }
  if (action === 'log') {
    const { results } = await DB.prepare('SELECT * FROM admin_log ORDER BY at DESC LIMIT 200').all();
    return { log: results };
  }
  throw new ApiError(404, '沒有這個功能');
}

/* ============================== 公開資料 ============================== */
async function catalog(env) {
  const svcs = (await services(env)).filter(s => s.active);
  const { results } = await env.DB.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort, sku').all();
  return { store: storeName(env), owner: env.OWNER_NAME || '', email: env.SUPPORT_EMAIL || '', mode: isProd(env) ? 'production' : 'stage',
    services: svcs.map(s => ({ id: s.id, name: s.name, icon: s.icon, tagline: s.tagline, description: s.description, url: s.url, buy_url: s.buy_url,
      products: results.filter(p => p.service_id === s.id).map(productOut) })) };
}
const ORDER_PUBLIC = o => ({ no: o.no, service: o.service_id, sku: o.sku, code: o.code, name: o.product_name, amount: o.amount, status: o.status,
  delivered: o.fulfill === 'done', payment_type: o.payment_type || '', rtn_msg: o.status === 'failed' ? (o.rtn_msg || '') : '', created_at: o.created_at, paid_at: o.paid_at });

/* ============================== 排程：出貨失敗自動重試 ============================== */
async function cron(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare("SELECT no, fulfill_tries FROM orders WHERE status = 'paid' AND fulfill IN ('failed', 'pending') AND fulfill_tries < 12 AND paid_at < ? ORDER BY paid_at LIMIT 20").bind(now() - 60000).all();
  for (const o of results) { try { await fulfill(env, o.no); } catch (e) { console.error('retry', o.no, e); } }
}

/* ============================== 路由 ============================== */
async function route(req, env, ctx) {
  const url = new URL(req.url), p = url.pathname.replace(/\/+$/, ''), M = req.method;
  const cors = await corsHeaders(req, env);
  const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  if (M === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    if (p === '/api/health') return J({ ok: true, mode: isProd(env) ? 'production' : 'stage' });
    if (p === '/api/catalog' && M === 'GET') return J(await catalog(env));
    if (p === '/api/status' && M === 'GET') return J({ mode: isProd(env) ? 'production' : 'stage', store: storeName(env) });
    if (p === '/api/checkout/start' && M === 'POST') return J(await checkoutStart(req, env, url));
    if (p === '/api/checkout/session' && M === 'GET') return J(await checkoutSession(env, url));
    if (p === '/api/checkout/pay' && M === 'POST') return J(await checkoutPay(req, env, url));
    if (p === '/api/ecpay/notify' && M === 'POST') return ecpayNotify(req, env, ctx);
    if (p === '/api/ecpay/result') return ecpayResult(req, env, url);
    if (p === '/api/order' && M === 'GET') {
      const o = await env.DB.prepare('SELECT * FROM orders WHERE no = ?').bind(String(url.searchParams.get('no') || '').slice(0, 20)).first();
      if (!o) throw new ApiError(404, '找不到這筆訂單');
      return J(ORDER_PUBLIC(o));
    }
    if (p === '/api/me/entitlements' && M === 'POST') {
      const x = await readJson(req); const svc = await serviceOf(env, x.service, { active: false });
      const u = await requireUser(req, [svc.firebase_project]);
      return J({ service: svc.id, ...await entitlementOf(env, svc.id, u.project, u.uid) });
    }
    if (p === '/api/me/orders' && M === 'POST') {
      const u = await requireUser(req, await allProjects(env));
      // 同一個人在不同網站可能是不同的登入專案：Email 驗證過的話，用 Email 一起找
      const { results } = await env.DB.prepare(`SELECT * FROM orders WHERE ((project = ? AND uid = ?) ${u.email && u.email_verified ? 'OR email = ?' : ''}) AND status != 'created' ORDER BY created_at DESC LIMIT 100`)
        .bind(u.project, u.uid, ...(u.email && u.email_verified ? [u.email] : [])).all();
      return J({ orders: results.map(ORDER_PUBLIC) });
    }
    let m;
    if ((m = p.match(/^\/api\/support\/([A-Za-z]+)$/)) && M === 'POST') return J(await support(m[1], req, env));
    if ((m = p.match(/^\/api\/admin\/([a-z-]+)$/)) && M === 'POST') return J(await admin(m[1], req, env));
    throw new ApiError(404, '找不到這個功能');
  } catch (e) {
    if (e instanceof ApiError) return J({ error: e.message, message: e.message, ...e.extra }, e.status);
    console.error(p, e && e.stack || e);
    return J({ error: '伺服器發生錯誤，請稍後再試', message: '伺服器發生錯誤，請稍後再試' }, 500);
  }
}

export default {
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    if (!path.startsWith('/api/') && env.ASSETS) return env.ASSETS.fetch(req);
    try { await ensureSchema(env); } catch (e) { console.error('schema', e); return new Response('資料庫還沒設定好（請看 README）', { status: 500 }); }
    return route(req, env, ctx);
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(cron(env)); },
};
export { ecpayMac, fulfill };
