// ==UserScript==
// @name         斗魚全屏隱藏進度條
// @namespace    eric-douyu-hide-progressbar
// @version      1.5.3
// @description  斗魚重播頁（v.douyu.com）隱藏底部控制列與進度條（全屏，或非全屏也可選），滑鼠移到畫面下緣時顯示；重播頁與直播間都可隱藏「斗魚」水印與暫停播放鍵。由 Tampermonkey 選單開啟設置。
// @homepageURL  https://github.com/happk/douyu-hide-progressbar
// @supportURL   https://github.com/happk/douyu-hide-progressbar/issues
// @license      MIT
// @match        *://v.douyu.com/*
// @match        *://www.douyu.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

/**
 * 與擴充功能版（extension/content.js）邏輯同源，改功能時兩邊要同步。
 * 差異：設定存 GM_getValue/GM_setValue；彈出視窗改為頁內浮動面板，
 * 由 Tampermonkey 選單「斗魚優化設置」開關。
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

  function loadSettings() {
    const s = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      const v = GM_getValue(k);
      if (v !== undefined) s[k] = v;
    }
    return s;
  }
  let settings = loadSettings();

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
  let panelHost = null;    // 設置面板

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
    // 面板開著時，跟著搬到新的 fullscreenElement 裡（否則全屏中看不到）
    if (panelHost && panelHost.isConnected) {
      (document.fullscreenElement || document.body).appendChild(panelHost);
      refreshPanelStatus();
    }
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
  function saveSetting(key, value) {
    settings[key] = value;
    GM_setValue(key, value);
    onSettingsChanged();
    refreshPanelStatus(); // 面板開著時，狀態區跟著開關即時刷新
  }

  function onSettingsChanged() {
    if (!barShouldHide() && weHidBar) showBar();
    applyWatermark();
    applyPauseIcon();
    applyBarState();
  }

  // ---- 設置面板（頁內浮動視窗；全屏中掛進 fullscreenElement 才看得到）----
  function getStatus() {
    const bh = findHost(BAR_TAG);
    const wm = findWatermark();
    const livePlayer = !!document.getElementById("room-html5-player");
    return {
      pageKind: bh ? "vod" : livePlayer ? "live" : "other",
      fullscreen: !!document.fullscreenElement,
      barFound: !!bh,
      barHidden: !!(bh && bh.style.display === "none" && weHidBar),
      wmFound: !!wm,
      wmHidden: !!(wm && wm.style.display === "none" && wmHidden),
    };
  }

  function statusLines() {
    const st = getStatus();
    const on = (v) => (v ? "開" : "關");
    const kindText =
      st.pageKind === "vod"
        ? "重播頁（隱藏控制列／播放鍵適用）"
        : st.pageKind === "live"
          ? "直播間（只處理水印，不碰控制列）"
          : "斗魚頁面（未偵測到播放器）";
    return [
      "頁面：" + kindText,
      "全屏：" + (st.fullscreen ? "是" : "否"),
      st.pageKind === "live"
        ? "控制列：直播間不處理"
        : "控制列元素：" + (st.barFound ? (st.barHidden ? "已由腳本隱藏" : "顯示中") : "找不到"),
      "水印元素：" + (st.wmFound ? (st.wmHidden ? "已隱藏" : "存在") : "找不到"),
      "設置：控制列隱藏 " + on(settings.hideBar) +
        "（非全屏也隱藏 " + on(settings.hideBarNonfull) + "）" +
        "／水印 " + on(settings.hideWatermark) +
        "／暫停播放鍵 " + on(settings.hidePauseBtn) +
        "／離底部 " + settings.zone + " px 內顯示",
    ].join("\n");
  }

  function buildPanel() {
    if (document.getElementById("dyhp-panel-style")) return;
    const css = document.createElement("style");
    css.id = "dyhp-panel-style";
    css.textContent = `
      #dyhp-panel { position: fixed; top: 16px; right: 16px; width: 280px; z-index: 2147483647;
        background: rgba(255,255,255,.97); border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.3);
        font: 13px/1.5 "Microsoft JhengHei","PingFang TC",sans-serif; color: #222; }
      #dyhp-panel h1 { font-size: 14px; margin: 0; padding: 8px 12px; border-bottom: 1px solid #eee;
        display: flex; justify-content: space-between; align-items: center; }
      #dyhp-close { border: 0; background: none; cursor: pointer; font-size: 13px; color: #888; padding: 2px 4px; }
      .dyhp-row { display: flex; align-items: center; gap: 8px; padding: 7px 12px; }
      .dyhp-row label { flex: 1; cursor: pointer; }
      .dyhp-slider-row { display: block; padding: 2px 12px 8px; }
      .dyhp-slider-row b { color: #e8663c; }
      #dyhp-panel input[type="range"] { width: 100%; accent-color: #e8663c; }
      #dyhp-status { margin: 2px 12px 8px; padding: 8px; background: #f6f6f6; border-radius: 6px;
        white-space: pre-line; font-size: 12px; color: #555; }
      .dyhp-hint { padding: 0 12px 10px; font-size: 11px; color: #999; }
    `;
    document.head.appendChild(css);

    panelHost = document.createElement("div");
    panelHost.id = "dyhp-panel";
    panelHost.innerHTML = `
      <h1>斗魚全屏優化設置 <button id="dyhp-close" title="關閉">✕</button></h1>
      <div class="dyhp-row"><input type="checkbox" id="dyhp-opt-bar"><label for="dyhp-opt-bar">全屏時隱藏控制列與進度條（重播頁）</label></div>
      <div class="dyhp-row"><input type="checkbox" id="dyhp-opt-nonfull"><label for="dyhp-opt-nonfull">非全屏也隱藏控制列，滑鼠靠近下緣才顯示（重播頁）</label></div>
      <div class="dyhp-row"><input type="checkbox" id="dyhp-opt-wm"><label for="dyhp-opt-wm">隱藏「斗魚」水印（重播頁與直播間）</label></div>
      <div class="dyhp-row"><input type="checkbox" id="dyhp-opt-pause"><label for="dyhp-opt-pause">隱藏暫停時右下角的播放鍵（重播頁）</label></div>
      <div class="dyhp-slider-row">
        <div>滑鼠離底部 <b id="dyhp-zone-val"></b> px 內顯示控制列</div>
        <input type="range" id="dyhp-opt-zone" min="60" max="240" step="10">
      </div>
      <div id="dyhp-status"></div>
      <div class="dyhp-hint">改動即時生效。控制列與暫停播放鍵功能只在重播頁作用；水印在重播頁與直播間都作用。</div>
    `;

    const $ = (sel) => panelHost.querySelector(sel);
    $("#dyhp-close").addEventListener("click", closePanel);
    const bindCheckbox = (id, key) => {
      const el = $("#" + id);
      el.checked = settings[key];
      el.addEventListener("change", () => saveSetting(key, el.checked));
    };
    bindCheckbox("dyhp-opt-bar", "hideBar");
    bindCheckbox("dyhp-opt-nonfull", "hideBarNonfull");
    bindCheckbox("dyhp-opt-wm", "hideWatermark");
    bindCheckbox("dyhp-opt-pause", "hidePauseBtn");
    const zone = $("#dyhp-opt-zone");
    zone.value = settings.zone;
    $("#dyhp-zone-val").textContent = settings.zone;
    zone.addEventListener("input", () => {
      const v = parseInt(zone.value, 10);
      $("#dyhp-zone-val").textContent = v;
      saveSetting("zone", v);
    });
  }

  function refreshPanelStatus() {
    if (panelHost && panelHost.isConnected) {
      panelHost.querySelector("#dyhp-status").textContent = statusLines();
    }
  }

  function openPanel() {
    buildPanel();
    // 全屏中要掛進 fullscreenElement，否則不會顯示
    (document.fullscreenElement || document.body).appendChild(panelHost);
    refreshPanelStatus();
  }

  function closePanel() {
    if (panelHost) {
      panelHost.remove();
    }
  }

  function togglePanel() {
    if (panelHost && panelHost.isConnected) {
      closePanel();
    } else {
      openPanel();
    }
  }

  // ---- 啟動 ----
  GM_registerMenuCommand("斗魚優化設置", togglePanel);

  document.addEventListener("fullscreenchange", onFullscreenChange);
  // capture：確保在任何 stopPropagation 之前收到事件
  document.addEventListener("mousemove", onMouseMove, { passive: true, capture: true });

  applyWatermark();
  applyPauseIcon();
  applyBarState();
  scheduleStartupRecheck();
})();
