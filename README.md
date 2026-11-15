# 節拍器

可離線使用的網頁節拍器（PWA），以 iPad Safari 為主要對象。

網址：https://razer1x2x3x.github.io/metronome/

- 鐘擺／光點兩種顯示，可切換
- BPM 20–300：± 按鈕（長按連續）、滑桿、點數字直接輸入
- 拍號 1/4–12/8，點圓點切換每拍的重音：中 → 大 → 靜音（大圓點＝重音，虛線＝靜音），「重設」全部回到中
- 細分拍：八分、三連音、十六分
- Tap 測速、四種音色、音量
- 常用速度下拉選單：義大利文速度術語＋中文、大略 BPM 區間（取自 Wikipedia〈Tempo〉）
- 鐘擺上的配重塊會依速度滑到刻度上對應的位置
- 我的速度：儲存常用的速度、拍號、重音設定

## 為什麼準

聲音由 Web Audio API 事先排入音訊硬體的時鐘，在指定的取樣點準時播放。不靠 JavaScript 計時器逐拍觸發，所以網路或畫面忙碌都不會影響節拍。載入一次之後由 Service Worker 快取，離線也能用。

## 部署到 GitHub Pages

1. 在 GitHub 建立新的 repository（例如 `metronome`，設為 Public）。
2. 在 repo 頁面選 **Add file → Upload files**，把這個資料夾裡的
   `index.html`、`sw.js`、`manifest.webmanifest`、`icons/` 整個拖進去，按 **Commit changes**。
3. 到 **Settings → Pages**，Source 選 **Deploy from a branch**，Branch 選 `main`／`/(root)`，按 Save。
4. 約一分鐘後網址會是 `https://<你的帳號>.github.io/metronome/`。

## 安裝到 iPad

1. 用 **Safari** 打開上面的網址。
2. 點分享按鈕 → **加入主畫面**。
3. 之後從主畫面圖示開啟，就是全螢幕的 App，離線也能用。

## 更新

修改檔案後重新上傳即可。App 會在背景下載新版，**下一次開啟**時生效。
建議同時把 `sw.js` 第一行的 `metronome-v1` 改成 `v2`、`v3`…，讓舊快取被清掉。

## 使用提醒

- 練習時螢幕會保持亮著（Wake Lock）。切到別的 App 或鎖定畫面時聲音會停，這是 iPadOS 對網頁的限制。
- 外接鍵盤：空白鍵 開始／停止，↑↓ 調速，T 測速。
