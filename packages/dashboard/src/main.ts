// @fan/dashboard — bootstrap entry point

// Tailwind + dashboard styles
import "./app.css";

// render/html not needed at module level — used only in component files

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DashboardConfig {
  apiUrl: string;
  token: string;
}

/** Reflects the dashboard-app custom element properties */
interface DashboardAppElement extends HTMLElement {
  apiUrl: string;
  token: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadConfig(): DashboardConfig | null {
  try {
    const raw = localStorage.getItem("fan-dashboard-config");
    if (!raw) return null;
    const cfg = JSON.parse(raw) as DashboardConfig;
    if (cfg.apiUrl && cfg.token) return cfg;
  } catch {
    // corrupted — ignore
  }
  return null;
}

function saveConfig(cfg: DashboardConfig): void {
  localStorage.setItem("fan-dashboard-config", JSON.stringify(cfg));
}

function clearConfig(): void {
  localStorage.removeItem("fan-dashboard-config");
}

// ---------------------------------------------------------------------------
// Dynamic import pattern — components will register themselves
// ---------------------------------------------------------------------------

import("./components/dashboard-app.js");
// connection-setup will be created in a later step; suppress until then
import("./components/connection-setup.js");

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("app");
  if (!root) throw new Error("#app element not found");

  const cfg = loadConfig();

  if (cfg) {
    // We have saved credentials — go straight to the dashboard
    const app = document.createElement("dashboard-app") as DashboardAppElement;
    app.apiUrl = cfg.apiUrl;
    app.token = cfg.token;
    root.appendChild(app);
  } else {
    // No credentials — show the connection setup screen
    showConnectionSetup(root);
  }

  // Global auth-error handler — redirect to connection setup
  window.addEventListener("fan:auth-error", () => {
    clearConfig();

    // Show a toast notification
    showToast("Authentication error — please reconnect");

    // Swap to connection setup after a short delay
    setTimeout(() => {
      if (!root) return;
      root.innerHTML = "";
      showConnectionSetup(root);
    }, 1500);
  });
});

function showConnectionSetup(root: HTMLElement): void {
  const setup = document.createElement("connection-setup");
  root.appendChild(setup);

  setup.addEventListener(
    "fan:connected",
    ((ev: CustomEvent<DashboardConfig>) => {
      saveConfig(ev.detail);

      const root = document.getElementById("app");
      if (!root) return;
      root.innerHTML = "";

      const app = document.createElement("dashboard-app") as DashboardAppElement;
      app.apiUrl = ev.detail.apiUrl;
      app.token = ev.detail.token;
      root.appendChild(app);
    }) as EventListener,
  );
}

function showToast(message: string): void {
  const toast = document.createElement("div");
  toast.className =
    "fixed top-4 right-4 z-50 bg-red-500 text-white px-4 py-2 rounded-lg shadow-lg fade-in text-sm";
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = "opacity 0.3s ease";
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
