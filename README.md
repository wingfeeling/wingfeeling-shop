# wingfeeling 數位商店（總店）

wingfeeling 所有網站共用的**收款＋客服＋許願池**中心。綠界只登記這個網站。

經營者：wingfeeling（個人經營）・客服信箱：wingfeeling@gmail.com

## 檔案

```
wrangler.toml        ← 要改：D1 資料庫 ID；綠界測試／正式（ECPAY_MODE）
worker/src/index.js  後端（資料表、預設的服務和商品第一次啟動時自動建立）
web/index.html       商店首頁：列出所有服務和商品（給綠界審核看的就是這頁）
web/pay.html         結帳頁：各網站按「購買」後跳到這裡
web/thanks.html      付款結果（服務沒設定回去的網址時用）
web/support.html     客服・許願池（所有服務共用）
web/orders.html      我的訂單（所有服務）
web/terms.html       購買須知與退款政策
web/privacy.html     隱私權政策
web/admin.html       管理後台：訂單・退款、客服・許願池、服務與商品、付費權限、操作紀錄
web/js/config.js     ← 總店自己的登入（Firebase）設定
```

## 第一次部署

1. GitHub 新增 repo `wingfeeling-shop`，把這些檔案放上去。
2. Cloudflare 主控台 → 儲存空間與資料庫 → D1 → 建立 `wingfeeling-shop-db`，把資料庫 ID 貼到 `wrangler.toml` 的 `database_id`。
3. Workers 和 Pages → 建立 → 匯入 GitHub repo `wingfeeling-shop`（Worker 名稱填 `wingfeeling-shop`）。
4. Worker → 設定 → 變數和祕密，新增祕密：`ECPAY_MERCHANT_ID`、`ECPAY_HASH_KEY`、`ECPAY_HASH_IV`。
5. Firebase 主控台 → `pdf-editor-54ab7` → Authentication → 設定 → 授權網域：加入 `wingfeeling-shop.wingfeeling.workers.dev`。
6. 打開 `https://wingfeeling-shop.wingfeeling.workers.dev/admin.html`，用 `ADMIN_EMAILS` 裡的帳號登入。

## 付款流程

1. 網站按「購買」→ `POST /api/checkout/start`（帶該網站的 Firebase 登入憑證，內容 `{"service":"服務代號","sku":"商品代號"}`）→ 拿到 `url` → 整頁跳過去。
2. 總店結帳頁：顯示商品、價格、購買須知 → 同意 → 前往綠界。
3. 綠界通知總店 → 驗證 → 訂單改成已付款 → 出貨：
   - **通知網站出貨**（webhook）：總店 POST 到服務的 hook 網址，網站自己把東西加進帳號。用於有後端的網站（AR 寵物、PDF 編輯器）。
   - **總店記錄權限**（hub）：總店記下付費版期限，網站呼叫 `POST /api/me/entitlements` 查。用於沒有後端的網站（語音轉文字）。
4. 付款完回到網站的 `return_url?order=訂單編號`。網站可以用 `GET /api/order?no=` 查狀態。

出貨失敗會每 10 分鐘自動重試，後台也可以按「重新出貨」。

## hook 格式（「通知網站出貨」的網站要實作）

總店 POST JSON 到 hook 網址，header：
- `x-shop-ts`：Unix 秒數
- `x-shop-sig`：`HMAC-SHA256(hook 密碼, x-shop-ts + "." + 原始內容)` 的 16 進位

網站要先驗證簽章（時間差 5 分鐘內），再看 `type`：

| type | 內容 | 要回 |
|---|---|---|
| `ping` | 測試連線 | `{"ok":true}` |
| `check` | `uid, project, email, sku, code, grant`：結帳前問可不可以買 | `{"ok":true}` 或 `{"ok":false,"message":"原因"}` |
| `paid` | `order{no, sku, code, amount, uid, project, email, paid_at, …}, grant`：出貨 | `{"ok":true}`（同一個 `order.no` 重送要能分辨，不能重複給） |
| `refund` | 同上：退款，收回 | `{"ok":true}` |
| `export_tickets` | `cursor`：把舊的客服訊息交給總店 | `{"ok":true,"tickets":[…],"next":下一頁 cursor 或 null}` |

`grant` 是後台商品設定的「付款後給什麼」JSON，內容由網站自己解讀。

## 新增一個服務

1. 管理後台 →「服務與商品」→「＋ 新增服務」，填代號、名稱、網址、登入用的 Firebase 專案、出貨方式。
   新服務建議跟總店共用 Firebase 專案 `pdf-editor-54ab7`，同一個人在各服務就是同一個帳號。
2. 新增商品（價格、付款後給什麼）。
3. 網站的「購買」按鈕呼叫 `/api/checkout/start`。
   - 「總店記錄權限」：網站登入後呼叫 `/api/me/entitlements` 查付費版，不用寫後端。
   - 「通知網站出貨」：網站後端照上面的 hook 格式實作，把 hook 密碼設成網站的祕密 `SHOP_HOOK_SECRET`。
4. 客服・許願池：網站可以直接連到 `support.html?service=代號`，或自己做畫面呼叫 `/api/support/*`。

## 退款

1. 綠界廠商後台退款（信用卡：信用卡收單 → 交易明細 → 退款；ATM 轉帳要自己匯回）。
2. 總店後台 →「訂單・退款」→「標記已退款」，總店會通知網站收回這筆訂單給的東西。
