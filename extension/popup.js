/** 工具列彈出視窗：設置開關 + 目前分頁狀態（除錯資訊） */
(() => {
  "use strict";

  const DEFAULTS = {
    hideBar: true,
    hideBarNonfull: true,
    hideWatermark: true,
    hidePauseBtn: true,
    zone: 120,
  };
  const $ = (id) => document.getElementById(id);
  const on = (v) => (v ? "開" : "關");

  function save(key, value) {
    chrome.storage.sync.set({ [key]: value });
  }

  function setStatus(text) {
    $("status").textContent = text;
  }

  function loadSettings() {
    chrome.storage.sync.get(DEFAULTS, (items) => {
      $("opt-bar").checked = items.hideBar;
      $("opt-nonfull").checked = items.hideBarNonfull;
      $("opt-wm").checked = items.hideWatermark;
      $("opt-pause").checked = items.hidePauseBtn;
      $("opt-zone").value = items.zone;
      $("zone-val").textContent = items.zone;
    });
  }

  function loadStatus() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const t = tabs && tabs[0];
      if (!t || !t.id) {
        setStatus("找不到目前分頁。");
        return;
      }
      // 分頁網址要靠 activeTab 權限（點圖示開啟 popup 時取得）；
      // 拿不到網址時不擋，直接問 content script 在不在
      let host = "";
      try {
        host = t.url ? new URL(t.url).hostname : "";
      } catch (_) {}
      if (host && host !== "douyu.com" && !host.endsWith(".douyu.com")) {
        setStatus("這個分頁不是斗魚。");
        return;
      }
      chrome.tabs.sendMessage(t.id, { type: "dyhp-getStatus" }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          setStatus("無法取得狀態：頁面是在安裝／更新前載入的，請重新整理斗魚分頁。");
          return;
        }
        const s = res.settings || {};
        const kindText =
          res.pageKind === "vod"
            ? "重播頁（隱藏控制列／播放鍵適用）"
            : res.pageKind === "live"
              ? "直播間（只處理水印，不碰控制列）"
              : "斗魚頁面（未偵測到播放器）";
        const lines = [
          "頁面：" + kindText,
          "全屏：" + (res.fullscreen ? "是" : "否"),
          res.pageKind === "live"
            ? "控制列：直播間不處理"
            : "控制列元素：" + (res.barFound ? (res.barHidden ? "已由插件隱藏" : "顯示中") : "找不到"),
          "水印元素：" + (res.wmFound ? (res.wmHidden ? "已隱藏" : "存在") : "找不到"),
          "設置：控制列隱藏 " + on(s.hideBar) +
            "（非全屏也隱藏 " + on(s.hideBarNonfull) + "）" +
            "／水印 " + on(s.hideWatermark) +
            "／暫停播放鍵 " + on(s.hidePauseBtn) +
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
    $("opt-nonfull").addEventListener("change", (e) => save("hideBarNonfull", e.target.checked));
    $("opt-wm").addEventListener("change", (e) => save("hideWatermark", e.target.checked));
    $("opt-pause").addEventListener("change", (e) => save("hidePauseBtn", e.target.checked));
    $("opt-zone").addEventListener("input", (e) => {
      const v = parseInt(e.target.value, 10);
      $("zone-val").textContent = v;
      save("zone", v);
    });
  });
})();
