/**
 * 斗魚影片（v.douyu.com）
 * 1. 全屏時隱藏底部控制列與進度條，滑鼠移到畫面下緣時顯示（彈出視窗可關閉）
 * 2. 隱藏左下角「斗魚」水印（彈出視窗可關閉）
 *
 * 原理：
 * 斗魚影片播放器是 Web Components，底部控制列整包放在
 * <demand-video-controller-bar> 這個元素裡（含細細的紅色進度條
 * ProgressBar），全部都在開放 Shadow DOM 底下；水印則是
 * <demand-video-watermark>（DOM 覆蓋層，不是烤進影片畫面的）。
 *
 * 做法：全屏時把控制列 host 元素 display:none；滑鼠移到下緣區時
 * 還原、交還斗魚原生邏輯，離開後延遲再隱藏。退出全屏時斗魚可能
 * 在事件之後才重建控制列（會帶著我們留下的 inline style），所以
 * 退出後連續校正幾次，確保一定復原。
 *
 * 設置存在 chrome.storage.sync，彈出視窗改動即時生效。
 */
(() => {
  "use strict";

  const DEFAULTS = {
    hideBar: true,        // 全屏時隱藏控制列與進度條
    hideWatermark: true,  // 隱藏左下角「斗魚」水印
    zone: 120,            // 滑鼠離底部多少 px 以內顯示控制列
  };
  const HIDE_DELAY = 300;  // 滑鼠離開下緣區後，延遲幾 ms 才隱藏（避免輕微晃動造成閃爍）

  const BAR_TAG = "DEMAND-VIDEO-CONTROLLER-BAR";
  const WM_TAG = "DEMAND-VIDEO-WATERMARK";

  let settings = { ...DEFAULTS };
  let barHost = null;
  let weHidBar = false;    // 目前的隱藏是不是我們設的（避免覆寫斗魚自己的行為）
  let hideTimer = null;
  let reassertTimers = [];
  let wmHidden = false;    // 水印目前是否由我們隱藏中
  let wmObserver = null;

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

  // ---- 控制列 ----
  function hideBar() {
    if (!settings.hideBar) return;
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
    if (document.fullscreenElement) {
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
    if (settings.hideBar) {
      // 斗魚可能在 fullscreenchange 之後才重建控制列（可能帶著我們的 inline style），
      // 連續校正幾次，確保退出全屏後一定復原
      [200, 600, 1200].forEach((ms) => {
        reassertTimers.push(setTimeout(applyBarState, ms));
      });
    }
  }

  function onMouseMove(e) {
    if (!settings.hideBar || !document.fullscreenElement) return;
    const inZone = e.clientY >= window.innerHeight - settings.zone;
    if (inZone) {
      clearTimeout(hideTimer);
      showBar();
    } else {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hideBar, HIDE_DELAY);
    }
  }

  // ---- 水印 ----
  function applyWatermark() {
    if (settings.hideWatermark) {
      const wm = findHost(WM_TAG);
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
    const wm = findHost(WM_TAG);
    if (wm && wm.style.display === "none") wm.style.display = "";
    wmHidden = false;
  }

  // 換影片 / 重新掛載播放器時水印元素會重建，用 MutationObserver 補隱藏。
  // 只對「真的新增了水印元素」的變動反應，避免彈幕列表頻繁插入觸發無謂的全域搜尋。
  function setupWatermarkObserver() {
    if (!settings.hideWatermark || wmObserver) return;
    wmObserver = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (
            n.nodeType === 1 &&
            (n.tagName === WM_TAG || (n.querySelector && n.querySelector(WM_TAG.toLowerCase())))
          ) {
            const wm = findHost(WM_TAG);
            if (wm && wm.style.display !== "none") {
              wm.style.display = "none";
              wmHidden = true;
            }
            return;
          }
        }
      }
    });
    wmObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ---- 設置 ----
  function onSettingsChanged() {
    if (!settings.hideBar && weHidBar) showBar();
    applyWatermark();
    applyBarState();
  }

  // ---- 彈出視窗的狀態查詢 ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "dyhp-getStatus") {
      const bh = findHost(BAR_TAG);
      const wm = findHost(WM_TAG);
      sendResponse({
        ok: true,
        settings: { ...settings },
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
    applyBarState();
  });
})();
