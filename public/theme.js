// Applies the saved Light / Dark choice before the page paints (no flash). "Auto" = no attribute = follow the device.
(function () {
  try {
    var t = localStorage.getItem("theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* storage unavailable: follow the device */ }
})();
