/** 工具列彈出視窗：設置開關 + 目前分頁狀態（除錯資訊） */
(() => {
  "use strict";

  const DEFAULTS = { hideBar: true, hideWatermark: true, zone: 120 };
  const $ = (id) => document.getElementById(id);

  function save(key, value) {
    chrome.storage.sync.set({ [key]: value });
  }

  function setStatus(text) {
    $("status").textContent = text;
  }

  function loadSettings() {
    chrome.storage.sync.get(DEFAULTS, (items) => {
      $("opt-bar").checked = items.hideBar;
      $("opt-wm").checked = items.hideWatermark;
      $("opt-zone").value = items.zone;
      $("zone-val").textContent = items.zone;
    });
  }

  function loadStatus() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const t = tabs && tabs[0];
      if (!t || !t.id || !t.url || !t.url.includes("v.douyu.com")) {
        setStatus("這個分頁不是斗魚影片頁（v.douyu.com）。");
        return;
      }
      chrome.tabs.sendMessage(t.id, { type: "dyhp-getStatus" }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          setStatus("無法取得狀態：頁面是在安裝／更新前載入的，請重新整理斗魚分頁。");
          return;
        }
        const s = res.settings || {};
        const lines = [
          "分頁狀態：" + (res.fullscreen ? "全屏中" : "非全屏"),
          "控制列元素：" + (res.barFound ? (res.barHidden ? "已由插件隱藏" : "顯示中") : "找不到"),
          "水印元素：" + (res.wmFound ? (res.wmHidden ? "已隱藏" : "存在") : "找不到"),
          "設置：控制列隱藏 " + (s.hideBar ? "開" : "關") +
            "／水印隱藏 " + (s.hideWatermark ? "開" : "關") +
            "／離底部 " + s.zone + " px 內顯示",
        ];
        setStatus(lines.join("\n"));
      });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    loadSettings();
    loadStatus();
    $("opt-bar").addEventListener("change", (e) => save("hideBar", e.target.checked));
    $("opt-wm").addEventListener("change", (e) => save("hideWatermark", e.target.checked));
    $("opt-zone").addEventListener("input", (e) => {
      const v = parseInt(e.target.value, 10);
      $("zone-val").textContent = v;
      save("zone", v);
    });
  });
})();
