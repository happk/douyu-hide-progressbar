# changelog — douyu-hide-progressbar（斗魚影片全屏隱藏進度條）

## v1.5.1 — 2026-11-04 — Tampermonkey腳本發布整備

- Greasy Fork 發布要求宣告授權：補 `// @license MIT`（允許任何人修改與轉發）。
- 補 `@homepageURL`／`@supportURL`，指向 GitHub repo。
- 設置面板開著時，切換開關／拉桿後狀態區即時刷新（原先要重開面板才更新）。
- 僅 Tampermonkey腳本版（`userscript/`）版號升至 1.5.1；擴充版維持 1.4.0 不變。

## v1.5.0 — 2026-11-04 — 新增 Tampermonkey 腳本版

- 新增 `userscript/douyu-hide-progressbar.user.js`：

  行為與擴充功能版（v1.4.0）相同，控制列／水印／暫停播放鍵邏輯同源；
  兩邊同步維護，改功能需同時改 `extension/content.js` 與 `userscript/`（見 `README_agent.md` 維護注意）。

- 設置介面：

  - `GM_registerMenuCommand` 註冊「斗魚優化設置」，點擊開啟頁內浮動面板（四個開關＋拉桿＋當頁狀態），取代擴充的工具列彈出視窗；
  - 全屏中面板掛進 `fullscreenElement` 才會顯示；
  - 儲存改用 `GM_getValue`／`GM_setValue`（本機），改動即存即套。

- 注入預測試（shim GM API）：

  水印／控制列顯隱與喚出、暫停播放鍵樣式、面板開關與拉桿即時生效，全部通過；Tampermonkey實裝待手測。

## v1.4.0 — 2026-11-04 — 暫停播放鍵隱藏 + 非全屏控制列選項

### 新增：隱藏暫停時右下角的大播放鍵（重播頁）

- 暫停時右下角出現的大圈播放鍵：

  位於 `<demand-video>` shadow root 內的 `img.play-icon[-show]`（62×62）；
  實測全頁唯一，控制列自己的播放鍵不是這個 class，不會誤傷。

- 做法：

  對 `<demand-video>` 的 shadow root 注入 `img[class*="play-icon"] { display:none !important }`；
  樣式跟著 shadow root 走，img 重建也吃到；
  播放器整包重建時由 MutationObserver 與 fullscreenchange 補掛，關閉選項即移除樣式。

- 驗證：暫停影片後注入樣式，截圖確認圈圈消失。

### 新增：非全屏也隱藏控制列（重播頁，預設開）

- 非全屏時控制列／進度條常駐（含暫停時），改為除非滑鼠移到播放器下緣才出現。
- 原本隱藏邏輯只在全屏作用；新增 `hideBarNonfull` 讓非全屏套用同一套顯隱（離開下緣 300ms 收起）。

  暫停常駐被一併覆蓋：`display:none` 直接壓過斗魚「暫停就讓控制列常駐」的行為，全屏暫停時同樣生效。
- 喚出區基準：

  全屏用視窗底緣（同以往）；
  非全屏用播放器 `video` 元素底緣——控制列隱藏時 host rect 會變 0×0，不能當基準——並加左右邊界（只在播放器橫向範圍內喚出）。
- video 查找限流 2 秒，直播間不白掃。

### 其他

- `NOTES.md` 改名 `README_agent.md` 並加入 gitignore（agent 筆記不入庫）；
  git 歷史以 filter-branch 重寫，將 `NOTES.md` 自所有 commit 移除。
- 兩個新設定預設「開」，彈出視窗（現共四個開關＋拉桿）可關。

### 驗證

- 播放鍵元素定位、唯一性與隱藏效果：實測通過；
- 非全屏隱藏行為與 popup 兩個新開關：尚未回測。

## v1.3.0 — 2026-11-04 — popup 誤判修復 + 直播間水印

### 問題

- popup 狀態區永遠顯示「這個分頁不是斗魚影片頁」：

  manifest 沒有 `tabs`／`activeTab` 權限，`tabs.query` 回傳的分頁物件不帶 `url`，網址檢查必然失敗。
  修法：加 `activeTab` 權限——點圖示開 popup 時臨時取得該分頁的網址即可，不用升級到會跳「讀取瀏覽記錄」警告的 `tabs`；
  拿不到網址時不擋，直接問 content script 在不在。

### 範圍：控制列／進度條限定重播頁

- 控制列功能只作用於重播（v.douyu.com）；直播間（www.douyu.com，含未開播時的自動輪播）完全不碰。
- 原本 content script 就認重播頁元素、直播間不會命中，行為不變；補兩個防呆：

  - mousemove 找控制列加 2 秒限流（直播間永遠找不到，避免滑鼠一動就全頁掃描）；
  - 退出全屏的定時校正，只在「真的找到過控制列 host」時安排。

### 新增：直播間（www.douyu.com）隱藏「斗魚」水印

- 直播水印是 `#room-html5-player` 內 class=`watermark-<hash>` 的 div：

  CSS module 帶 build hash，全頁唯一；
  內容有「斗鱼 房间号：…」「房间靓号」、輪播「录像场次：…」；
  `display:none` 可除，截圖前後對照確認。

- 選擇器：穩定 id `#room-html5-player` + class 含 `watermark` 比對。
- 輪播頁（6657）水印掛載較晚（實測 2.5 秒時還沒出現、5 秒內出現），既有 MutationObserver 負責接住。
- manifest：content_scripts 加 `*://www.douyu.com/*`；
  水印查找改為先試直播選擇器（便宜 querySelector）再穿透 shadow DOM 找重播水印。

### 其他

- popup 狀態區改顯示頁面類型（重播頁／直播間／其他斗魚頁面），直播間不再出現「控制列元素：找不到」的誤導字樣；開關標籤補註適用範圍。
- 新增 `testing/`（回測步驟與紀錄表，gitignore 不入庫）與 `.gitignore`。
- 事前驗證：11106244／6657 水印隱藏有效、重播頁 bar／wm 元素健在（v1.2.x 邏輯未動）；popup 修復效果尚未回測。

## v1.2.1 — 2026-11-04 — 設置面板文案修正（「下緣顯示區高度」語意不準確）

### 問題

- popup slider 原名「下緣顯示區高度」語意不清：

  該參數實際是「滑鼠游標進入畫面底部多高的範圍時喚出控制列」的感應距離，與任何顯示內容無關。
  實測參考值：1080p 螢幕設 120 = 螢幕最底 120px 橫帶；
  控制列本身全屏時約 82px 高（720p 實測），120 ≈ 控制列 + 上方 38px 緩衝帶。

### 修改

- slider 標籤改為「滑鼠離底部 X px 內顯示控制列」，X 為即時數值。
- 順手移除 `.head` 的 flex 佈局：標籤改為含數值的單行文字，原 space-between 會把文字和數值拆到兩端。
- popup 狀態區對應欄位改為「離底部 N px 內顯示」。
- `content.js` DEFAULTS 補每個參數的白話註解；README 設置表同步。

## v1.2.0 — 2026-11-04 — 退出全屏殘留隱藏修復 + 水印去除 + 設置面板

### 問題（v1.0.0 bug）

- 進全屏再退出後，**非全屏**模式控制列也消失。

  根因：斗魚在 `fullscreenchange` 事件**之後**才重建控制列，重建元素帶著我們留在舊元素上的 `display:none` inline style。

- 修復：

  退出全屏後於 200/600/1200ms 重新定位控制列 host 並校正（`applyBarState`）；
  引入 `weHidBar` 旗標，只有「我們藏的」才還原——斗魚自己的顯隱走內層 `.ControllerBar` 的 inline `visibility` + `ismousein`，不能覆寫。

### 新增：隱藏左下角「斗魚」水印

- 實測水印為 DOM 覆蓋層 `<demand-video-watermark>`（非烤進影片畫面），host `display:none` 即可，不限全屏、全程隱藏。
- MutationObserver 補隱藏（換影片／重新掛載時元素會重建）；
  observer 只對「真的新增了水印元素」的變動反應，避免右側彈幕列表頻繁插入觸發全域搜尋。
- 彈出視窗可開關；關閉時還原顯示並斷開 observer。

### 新增：工具列彈出視窗

- 圖示應可設置與看除錯資訊，而不是安裝前改參數。
- popup：兩個開關（全屏隱藏控制列／隱藏水印）、slider（感應距離 60–240px）、分頁狀態除錯（全屏與否、控制列／水印元素是否找到、是否已由插件隱藏；非斗魚分頁或頁面未重新整理時顯示對應提示）。
- 設置存 `chrome.storage.sync`，content script 監聽 `onChanged` 即時套用；
  manifest 加 `storage` 權限與 `action.default_popup`。

### 驗證

- 修復效果與水印／面板尚未回測。

## v1.0.0 — 2026-11-04 — 初版

### 實測基礎（v.douyu.com/show/<id>，CS2 直播錄像，1280×720）

- 播放器全為開放 Shadow DOM Web Components；`document.querySelector("video")` 找不到 video（藏在 shadow root）。
- 控制列 host `<demand-video-controller-bar>`（id `demandcontroller-bar`）；全屏時內層 `.ControllerBar` 加 `is-fullscreen` 類、高 82px。
- 畫面上殘留的「部分進度條」= 內層 `div.ProgressBar`，僅 3px 高（y 675–678），疊在控制列上緣。
- 官方無「隱藏進度條」設置；Greasy Fork 現有腳本（better-DouYu、DouyuEx、改掉斗鱼各种烦人的地方、隐藏礼物栏等）全部針對 www.douyu.com 直播間，查證後無一涵蓋此需求 → 客製插件。

### 功能

- 全屏（`document.fullscreenElement`）時控制列 host `display:none`，整包含細進度條一起隱藏；
  滑鼠進入底部 120px 顯示、離開後 300ms 隱藏。
- 非全屏與「網頁全屏」（`ControllerBar-PageFull`）不介入；只 match `v.douyu.com`。
- MV3、無需特殊權限、無安裝相依。

### 已知問題

- 退出全屏後非全屏控制列殘留隱藏（→ v1.2.0 修復）。

---

（v1.1.0 為空號：水印功能原定獨立版本，開發中併入 v1.2.0。）
