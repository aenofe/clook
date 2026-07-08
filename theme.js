// ============================================
// THEME TOGGLE (dark / light mode)
// ============================================
//
// The actual switch already happened before this file even loaded - see the
// small inline <script> sitting in every page's <head>. That one runs
// IMMEDIATELY (it's not type="module", so it's not deferred) and sets
// data-theme on <html> based on what's saved in localStorage. That's what
// stops you from seeing a flash of light mode for a split second on every
// page load before this file gets a chance to run.
//
// This file's only job is the TOGGLE BUTTON: show the right label, and
// switch + save the theme when it's clicked.

const toggleBtn = document.getElementById("theme-toggle");

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") || "light";
}

function updateButtonLabel() {
  if (!toggleBtn) return;
  toggleBtn.textContent = currentTheme() === "dark" ? "Light" : "Dark";
}

if (toggleBtn) {
  updateButtonLabel();

  toggleBtn.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";

    // Update the page immediately...
    document.documentElement.setAttribute("data-theme", next);
    updateButtonLabel();

    // ...and save the choice so it's remembered next time (and on other
    // pages - localStorage is shared across every page on the same site).
    localStorage.setItem("clook-theme", next);
  });
}
