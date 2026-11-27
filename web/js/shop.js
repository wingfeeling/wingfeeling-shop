/* 總店共用：頁首頁尾、呼叫後端、Google 登入（有載入 Firebase 的頁面才有） */
(function () {
  const C = window.SHOP_CONFIG || {};
  let auth = null, user = null;
  try { if (window.firebase && C.firebase && C.firebase.apiKey) { firebase.initializeApp(C.firebase); auth = firebase.auth(); auth.languageCode = 'zh-TW'; } } catch (e) { console.warn(e); }
  const listeners = [];
  const ready = new Promise(res => { if (!auth) return res(null); auth.onAuthStateChanged(u => { user = u; listeners.forEach(f => f(u)); res(u); }); });
  const inApp = () => /Line\/|FBAN|FBAV|Instagram|MicroMessenger/i.test(navigator.userAgent);
  function loginErr(code, msg) {
    if (/unauthorized-domain/.test(code)) return `登入失敗：這個網址（${location.hostname}）還沒加進 Firebase 的「授權網域」。`;
    if (/network-request-failed/.test(code)) return '登入失敗：連不上 Google，請確認網路後再試';
    if (/too-many-requests/.test(code)) return '登入嘗試太多次，請過幾分鐘再試';
    if (/internal-error|web-storage-unsupported/.test(code)) return '登入失敗：瀏覽器擋住了登入需要的儲存空間（無痕模式或封鎖第三方 Cookie 時會這樣），請換一般視窗再試';
    return '登入失敗：' + (msg || code);
  }
  async function signIn() {
    if (!auth) throw new Error('登入功能還沒載入，請重新整理頁面');
    if (inApp()) { alert('LINE、Facebook、Instagram 裡面的瀏覽器不能用 Google 登入（Google 的規定）。\n請按右上角「⋯」選「用瀏覽器開啟」後再登入。'); throw new Error('已取消登入'); }
    const p = new firebase.auth.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
    try { const r = await auth.signInWithPopup(p); user = r.user; return user; }
    catch (e) {
      const code = e.code || '';
      if (/popup-blocked|operation-not-supported/.test(code)) { await auth.signInWithRedirect(p); return null; }
      if (/popup-closed|cancelled-popup/.test(code)) throw new Error('已取消登入');
      throw new Error(loginErr(code, e.message));
    }
  }
  if (auth) auth.getRedirectResult().catch(e => { if (!/popup-closed|cancelled|no-auth-event/.test(e.code || '')) alert(loginErr(e.code || '', e.message)); });
  async function signOut() { if (auth) await auth.signOut(); location.reload(); }
  async function api(path, body) {
    const h = {};
    await ready; if (user) h.authorization = 'Bearer ' + await user.getIdToken();
    if (body !== undefined) h['content-type'] = 'application/json';
    let r;
    try { r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch { throw new Error('連不上伺服器，請確認網路後再試'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error || ('錯誤 ' + r.status)); e.status = r.status; e.data = d; throw e; }
    return d;
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => 'NT$ ' + Number(n || 0).toLocaleString('zh-TW');
  function fmt(v, time = true) {
    if (!v) return ''; const d = new Date(v); if (isNaN(d)) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}` + (time ? ` ${p(d.getHours())}:${p(d.getMinutes())}` : '');
  }
  function toast(m) { let t = document.getElementById('toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.append(t); } t.textContent = m; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 4500); }
  function header(active) {
    const el = document.getElementById('top'); if (!el) return;
    const links = [['index.html', '商品'], ['orders.html', '我的訂單'], ['support.html', '客服・許願池'], ['terms.html', '購買須知']];
    el.className = 'top';
    el.innerHTML = `<div class="wrap"><a class="brand" href="index.html"><i>W</i><span>${esc(C.storeName)}</span></a>
      <nav>${links.map(([h, t]) => `<a href="${h}" class="${active === h ? 'on' : ''}">${t}</a>`).join('')}</nav></div>`;
  }
  function footer() {
    const f = document.querySelector('footer'); if (!f || f.dataset.done) return; f.dataset.done = 1;
    f.innerHTML = `<div class="wrap"><div class="links"><a href="index.html">全部商品</a><a href="terms.html">購買須知與退款政策</a><a href="privacy.html">隱私權政策</a><a href="support.html">客服・許願池</a><a href="orders.html">我的訂單</a></div>
      <div>${esc(C.storeName)}・經營者：${esc(C.owner)}（個人經營）・客服信箱：<a href="mailto:${esc(C.supportEmail)}">${esc(C.supportEmail)}</a></div>
      <div>${esc(C.ownerNote || '')} 付款由綠界科技 ECPay 處理，本店不會取得你的信用卡資料。</div>
      <div>© ${new Date().getFullYear()} ${esc(C.owner)} 版權所有</div></div>`;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', footer); else footer();
  window.Shop = { config: C, ready, signIn, signOut, api, esc, money, fmt, toast, header, loginErr, get user() { return user; }, onAuth: f => listeners.push(f), hasAuth: () => !!auth };
})();
