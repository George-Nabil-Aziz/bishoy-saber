// ---------- Start ----------
initAuth().finally(() => {
  applyLang();
  applyTheme();
  render();
  checkStatus();
});
