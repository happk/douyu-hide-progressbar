/**
 * 斗魚重播頁（v.douyu.com）與直播間（www.douyu.com）
 * 1. 重播頁：全屏（可選：非全屏也）隱藏底部控制列與進度條，
 *    滑鼠移到畫面下緣時顯示（彈出視窗可關閉）
 * 2. 重播頁與直播間：隱藏「斗魚」水印（彈出視窗可關閉）
 * 3. 重播頁：隱藏暫停時右下角的大播放鍵（彈出視窗可關閉）
 *
 * 原理：
 * 重播頁播放器是 Web Components，底部控制列整包放在
 * <demand-video-controller-bar> 這個元素裡（含細細的紅色進度條
 * ProgressBar），全部都在開放 Shadow DOM 底下；水印則是
 * <demand-video-watermark>（DOM 覆蓋層，不是烤進影片畫面的）。
 * 暫停時右下角的大播放鍵是 <demand-video> shadow root 裡的
 * img.play-icon（2026-11-04 實測全頁唯一），對 shadow root 注入
 * 樣式即可隱藏，元素重建也會吃到。
 * 直播間播放器（#room-html5-player）是另一套技術，控制列我們完全不碰；
 * 水印是播放器容器內 class 以 watermark 開頭的 div（CSS module 會帶
 * build hash，用「含 watermark」比對；2026-11-04 實測全頁唯一），
 * 內容有「斗鱼 房间号：…」「房间靓号」「录像场次：…」幾種。
 *
 * 做法：把控制列 host 元素 display:none；滑鼠移到下緣區時還原、
 * 交還斗魚原生邏輯，離開後延遲再隱藏。喚出區的基準：全屏用視窗底、
 * 非全屏用播放器（video 元素）底緣。退出全屏時斗魚可能在事件之後才
 * 重建控制列（會帶著我們留下的 inline style），所以退出後連續校正幾次。
 * 水印兩種頁面都用 display:none，換影片／換畫質時元素會重建，
 * 用 MutationObserver 補隱藏（直播間水印掛載較晚，實測 3–5 秒才出現）。
 *
 * 設置存在 chrome.storage.sync，彈出視窗改動即時生效。
 */
(() => {
  "use strict";

  const DEFAULTS = {
    hideBar: true,        // 重播頁：全屏時隱藏控制列與進度條
    hideBarNonfull: true, // 重播頁：非全屏也隱藏控制列，滑鼠靠近播放器下緣才顯示
    hideWatermark: true,  // 隱藏「斗魚」水印（重播頁與直播間）
    hidePauseBtn: true,   // 隱藏暫停時右下角的大播放鍵（重播頁）
    zone: 120,            // 滑鼠離播放器底部多少 px 以內顯示控制列
  };
  const HIDE_DELAY = 300;  // 滑鼠離開下緣區後，延遲幾 ms 才隱藏（避免輕微晃動造成閃爍）

  const BAR_TAG = "DEMAND-VIDEO-CONTROLLER-BAR";
  const VIDEO_TAG = "DEMAND-VIDEO";
  const VOD_WM_TAG = "DEMAND-VIDEO-WATERMARK";
  // 直播間水印：穩定錨點是播放器容器 id；水印自身 class 帶 build hash，
  // 用「class 含 watermark」比對（選擇器失敗也不會誤傷，頂多隱不到）
  const LIVE_WM_SELECTOR = '#room-html5-player div[class*="watermark"]';
  // 暫停時右下角的大播放鍵：img.play-icon[-show]，實測全頁唯一
  const PAUSE_ICON_STYLE = 'img[class*="play-icon"] { display: none !important; }';

  let settings = { ...DEFAULTS };
  let barHost = null;
  let weHidBar = false;    // 目前的隱藏是不是我們設的（避免覆寫斗魚自己的行為）
  let hideTimer = null;
  let reassertTimers = [];
  let wmHidden = false;    // 水印目前是否由我們隱藏中
  let wmObserver = null;
  let lastBarLookup = 0;   // 上次全頁找控制列 host 的時間（找不到时限流，直播間不白掃）
  let videoEl = null;      // 重播頁的 <video>（非全屏喚出區以它底緣為基準）
  let lastVideoLookup = 0;
  let pauseStyleEl = null; // 放在 DEMAND-VIDEO shadow root 裡的樣式
  let shadowObservedRoot = null; // 已掛 observer 的 <demand-video> shadow root
  let shadowObserver = null;     // 觀察 shadow root 內部的水印／播放鍵插入
  const STARTUP_TICKS = [500, 1000, 2000, 4000, 8000, 15000, 30000]; // 啟動退避重試間隔
  let startupIndex = 0;

  // ---- 穿透所有開放 Shadow DOM 找指定 tag 的自訂元素（host）----
  function findHost(tag) {
    let found = null;
    const walk = (root) => {
      if (found) return;
      for (const el of root.querySelectorAll("*")) {
        if (el.tagName === tag) {
          found = el;
          return;
        }
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return found;
  }

  function ensureHost() {
    // SPA 換頁時元素可能被重建，斷線就重找
    if (!barHost || !barHost.isConnected) barHost = findHost(BAR_TAG);
    return barHost;
  }

  // 找重播頁的 <video>（連限流一起處理，直播間找不到也不會狂掃）
  function ensureVideoEl() {
    if (videoEl && videoEl.isConnected) return videoEl;
    const now = Date.now();
    if (now - lastVideoLookup < 2000) return null;
    lastVideoLookup = now;
    const host = findHost(VIDEO_TAG);
    videoEl = host && host.shadowRoot ? host.shadowRoot.querySelector("video") : null;
    ensureShadowObserver();
    return videoEl;
  }

  // ---- 控制列（只作用於重播頁：直播間沒有這個元素，永不命中）----
  // 現在該不該藏：全屏看 hideBar，非全屏看 hideBarNonfull
  function barShouldHide() {
    return document.fullscreenElement ? settings.hideBar : settings.hideBarNonfull;
  }

  function hideBar() {
    if (!barShouldHide()) return;
    const host = ensureHost();
    if (host && host.style.display !== "none") {
      host.style.display = "none";
    }
    if (host) weHidBar = true;
  }

  function showBar() {
    const host = ensureHost();
    if (host) {
      if (host.style.display === "none") host.style.display = "";
      weHidBar = false;
      // 若斗魚自己把內部控制列設成 visibility:hidden（滑鼠閒置自動隱藏），一併打開
      const inner = host.shadowRoot && host.shadowRoot.querySelector(".ControllerBar");
      if (inner && inner.style.visibility === "hidden") {
        inner.style.visibility = "visible";
      }
    }
  }

  // 依當前全屏狀態校正控制列；每次都重新定位，避免重建後指到舊元素
  function applyBarState() {
    const host = findHost(BAR_TAG);
    if (host) barHost = host;
    if (barShouldHide()) {
      hideBar();
    } else if (weHidBar) {
      showBar();
    }
  }

  function onFullscreenChange() {
    clearTimeout(hideTimer);
    reassertTimers.forEach(clearTimeout);
    reassertTimers = [];
    applyBarState();
    applyWatermark(); // 全屏切換可能重新掛載播放器，補隱藏一次
    applyPauseIcon(); // 重建後 shadow root 是新的，樣式要補掛
    if (barHost) {
      // 斗魚可能在 fullscreenchange 之後才重建控制列（可能帶著我們的 inline style），
      // 連續校正幾次，確保退出全屏後一定復原。
      // 只有真的找到過控制列（重播頁）才安排，直播間不做這些定時全頁掃描
      [200, 600, 1200].forEach((ms) => {
        reassertTimers.push(setTimeout(applyBarState, ms));
      });
    }
  }

  // 滑鼠是否在「喚出控制列」的下緣區：全屏用視窗底，非全屏用播放器底緣
  // （控制列隱藏時 host rect 會變 0，不能拿它當基準，所以用 video 元素）
  function mouseInRevealZone(e) {
    const zone = settings.zone;
    let bottom = window.innerHeight;
    let left = 0;
    let right = window.innerWidth;
    if (!document.fullscreenElement) {
      const v = ensureVideoEl();
      if (v) {
        const r = v.getBoundingClientRect();
        if (r.height > 0) {
          bottom = r.bottom;
          left = r.left;
          right = r.right;
        }
      }
    }
    return (
      e.clientY >= bottom - zone && e.clientY <= bottom &&
      e.clientX >= left && e.clientX <= right
    );
  }

  function onMouseMove(e) {
    if (!barShouldHide()) return;
    if (!barHost) {
      // 全頁搜尋有限流：找不到就 2 秒內不再試（直播間永遠找不到，避免滑鼠一動就掃一次）
      const now = Date.now();
      if (now - lastBarLookup < 2000) return;
      lastBarLookup = now;
      if (!ensureHost()) return;
    }
    if (mouseInRevealZone(e)) {
      clearTimeout(hideTimer);
      showBar();
    } else {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hideBar, HIDE_DELAY);
    }
  }

  // ---- 水印（重播頁與直播間兩種，找到哪種處理哪種）----
  function findWatermark() {
    // 直播間：一般 DOM，querySelector 就找得到（重播頁沒有這個 id，直接撲空）
    const live = document.querySelector(LIVE_WM_SELECTOR);
    if (live) return live;
    // 重播頁：藏在 shadow DOM 裡，要穿透找
    return findHost(VOD_WM_TAG);
  }

  function applyWatermark() {
    if (settings.hideWatermark) {
      const wm = findWatermark();
      if (wm && wm.style.display !== "none") {
        wm.style.display = "none";
      }
      wmHidden = !!wm;
      setupWatermarkObserver();
    } else {
      restoreWatermark();
    }
  }

  function restoreWatermark() {
    if (wmObserver) {
      wmObserver.disconnect();
      wmObserver = null;
    }
    const wm = findWatermark();
    if (wm && wm.style.display === "none") wm.style.display = "";
    wmHidden = false;
  }

  // 換影片 / 換畫質 / 重新掛載播放器時水印元素會重建，用 MutationObserver 補隱藏。
  // 只對「真的新增了水印元素」的變動反應，避免彈幕／推薦列表頻繁插入觸發無謂的全域搜尋。
  function setupWatermarkObserver() {
    if (!settings.hideWatermark || wmObserver) return;
    wmObserver = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const hit =
            n.tagName === VOD_WM_TAG ||
            n.tagName === VIDEO_TAG ||
            (n.matches && n.matches(LIVE_WM_SELECTOR)) ||
            (n.querySelector &&
              (n.querySelector(VOD_WM_TAG.toLowerCase()) ||
                n.querySelector(VIDEO_TAG.toLowerCase()) ||
                n.querySelector(LIVE_WM_SELECTOR)));
          if (hit) {
            applyWatermark(); // 播放器（或水印）掛載，重新套用
            applyPauseIcon(); // 整個播放器重建時 shadow root 是新的，樣式補掛
            ensureShadowObserver();
            ensureVideoEl();
            return;
          }
        }
      }
    });
    wmObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ---- 暫停時右下角的大播放鍵（重播頁）----
  function applyPauseIcon() {
    if (!settings.hidePauseBtn) {
      restorePauseIcon();
      return;
    }
    // 樣式已掛著就什麼都不做（平常每次呼叫都是這條，開銷極低）
    if (pauseStyleEl && pauseStyleEl.isConnected) return;
    const host = findHost(VIDEO_TAG);
    if (!host || !host.shadowRoot) return;
    if (!videoEl) videoEl = host.shadowRoot.querySelector("video");
    // 樣式放進 shadow root：img 元素重建也會吃到，不用 observer 逐個補
    pauseStyleEl = document.createElement("style");
    pauseStyleEl.textContent = PAUSE_ICON_STYLE;
    host.shadowRoot.appendChild(pauseStyleEl);
    ensureShadowObserver();
  }

  function restorePauseIcon() {
    if (pauseStyleEl) {
      pauseStyleEl.remove();
      pauseStyleEl = null;
    }
  }

  // body 的 observer 看不到 shadow root 內部的變更（水印、播放鍵都掛在那裡），
  // 找到播放器後把另一個 observer 直接掛進 <demand-video> 的 shadow root；
  // 播放器重建（shadow root 換新）時，下次發現後會自動重掛。
  function ensureShadowObserver() {
    let root = null;
    if (videoEl && videoEl.isConnected) {
      root = videoEl.getRootNode();
    } else if (pauseStyleEl && pauseStyleEl.isConnected) {
      root = pauseStyleEl.getRootNode();
    }
    if (!root || root === document || shadowObservedRoot === root) return;
    if (shadowObserver) shadowObserver.disconnect();
    shadowObserver = new MutationObserver(() => {
      applyWatermark();
      applyPauseIcon();
    });
    shadowObserver.observe(root, { childList: true, subtree: true });
    shadowObservedRoot = root;
  }

  // 啟動退避重試：腳本執行時播放器往往還沒掛載，開場套用會撲空；
  // 以 0.5s→30s 的間隔各補一次（有界），之後交給事件驅動的路徑。
  function scheduleStartupRecheck() {
    if (startupIndex >= STARTUP_TICKS.length) return;
    const delay = STARTUP_TICKS[startupIndex++];
    setTimeout(() => {
      applyWatermark();
      applyPauseIcon();
      applyBarState();
      scheduleStartupRecheck();
    }, delay);
  }

  // ---- 設置 ----
  function onSettingsChanged() {
    if (!barShouldHide() && weHidBar) showBar();
    applyWatermark();
    applyPauseIcon();
    applyBarState();
  }

  // ---- 彈出視窗的狀態查詢 ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "dyhp-getStatus") {
      const bh = findHost(BAR_TAG);
      const wm = findWatermark();
      const livePlayer = !!document.getElementById("room-html5-player");
      sendResponse({
        ok: true,
        settings: { ...settings },
        pageKind: bh ? "vod" : livePlayer ? "live" : "other",
        fullscreen: !!document.fullscreenElement,
        barFound: !!bh,
        barHidden: !!(bh && bh.style.display === "none" && weHidBar),
        wmFound: !!wm,
        wmHidden: !!(wm && wm.style.display === "none" && wmHidden),
      });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
    onSettingsChanged();
  });

  document.addEventListener("fullscreenchange", onFullscreenChange);
  // capture：確保在任何 stopPropagation 之前收到事件
  document.addEventListener("mousemove", onMouseMove, { passive: true, capture: true });

  // 讀設置後套用（applyBarState 也涵蓋「載入時已在全屏」的罕見情況）
  chrome.storage.sync.get(DEFAULTS, (items) => {
    settings = { ...DEFAULTS, ...items };
    applyWatermark();
    applyPauseIcon();
    applyBarState();
    scheduleStartupRecheck();
  });
})();
