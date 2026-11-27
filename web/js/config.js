/* ===== 總店網頁設定（都是公開資訊） =====
   firebase：總店自己的登入（客服頁、我的訂單、管理後台）。
   現在跟「凌的萬用pdf編輯器」、「語音轉文字」共用同一個 Firebase 專案，同一個 Google 帳號在這三個地方是同一個人。
   ★ 要到 Firebase 主控台 → pdf-editor-54ab7 → Authentication → 設定 → 授權網域，加入總店的網域
     （例如 wingfeeling-shop.wingfeeling.workers.dev），不然登入會出現 auth/unauthorized-domain。 */
window.SHOP_CONFIG = {
  storeName: 'wingfeeling 數位商店',
  owner: 'wingfeeling',
  ownerNote: '本商店為個人經營，回覆較慢請見諒。',
  supportEmail: 'wingfeeling@gmail.com',
  firebase: {
    apiKey: 'AIzaSyAnsN72g5l4VlensGpgwY9R3FFRKKoV1PE',
    authDomain: 'pdf-editor-54ab7.firebaseapp.com',
    projectId: 'pdf-editor-54ab7',
    appId: '1:661653578609:web:a20b46249eae6ab7888cd0'
  }
};
