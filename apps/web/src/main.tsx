import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { App } from "./ui/App";
import { LoginPage } from "./ui/LoginPage";
import { RegisterPage } from "./ui/RegisterPage";
import { ResetPasswordPage } from "./ui/ResetPasswordPage";
import { AuthGate } from "./ui/AuthGate";
import "./styles.css";

const BUILD_KEY = "app_build_id";
const BUILD_RELOAD_GUARD = "app_build_reload_done";
const REMOTE_BUILD_META = "app-build-id";

async function purgeBrowserCaches() {
  if (typeof window === "undefined") return;
  if ("serviceWorker" in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  }
  if ("caches" in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  }
}

async function applyBuildRefreshPolicy() {
  const currentBuild = __APP_BUILD_ID__;
  const previousBuild = localStorage.getItem(BUILD_KEY);
  if (!previousBuild) {
    localStorage.setItem(BUILD_KEY, currentBuild);
    return;
  }
  if (previousBuild !== currentBuild) {
    localStorage.setItem(BUILD_KEY, currentBuild);
    localStorage.removeItem("migration-2026-08-to-2026-05-default-budget");
    localStorage.removeItem("migration-accounts-2026-08-to-2026-05-default-budget");
    localStorage.removeItem("migration-accounts-2026-09-to-2026-05-v3-default-budget");
    await purgeBrowserCaches();
    if (sessionStorage.getItem(BUILD_RELOAD_GUARD) !== currentBuild) {
      sessionStorage.setItem(BUILD_RELOAD_GUARD, currentBuild);
      window.location.reload();
    }
  }
}

function extractBuildIdFromHtml(html: string) {
  const re = /<meta\s+name=["']app-build-id["']\s+content=["']([^"']+)["']/i;
  return re.exec(html)?.[1] ?? "";
}

async function fetchRemoteBuildId() {
  const res = await fetch(`/index.html?t=${Date.now()}`, { cache: "no-store" });
  const html = await res.text();
  return extractBuildIdFromHtml(html);
}

function UpdateAwareApp() {
  const [updateAvailable, setUpdateAvailable] = React.useState(false);
  const [checking, setChecking] = React.useState(false);

  const reloadToLatest = React.useCallback(async () => {
    localStorage.setItem(BUILD_KEY, __APP_BUILD_ID__);
    await purgeBrowserCaches();
    window.location.reload();
  }, []);

  const checkForUpdate = React.useCallback(async () => {
    if (checking) return;
    try {
      setChecking(true);
      const remoteBuild = await fetchRemoteBuildId();
      if (remoteBuild && remoteBuild !== __APP_BUILD_ID__) {
        localStorage.setItem(REMOTE_BUILD_META, remoteBuild);
        setUpdateAvailable(true);
      }
    } catch {
      // Silent fallback when offline.
    } finally {
      setChecking(false);
    }
  }, [checking]);

  React.useEffect(() => {
    void applyBuildRefreshPolicy();
    void checkForUpdate();
    let cleanupSw: (() => void) | null = null;
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((reg) => {
          void reg.update();
          if (reg.waiting) {
            reg.waiting.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
      const onControllerChange = () => window.location.reload();
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
      cleanupSw = () => {
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      };
    }
    const interval = window.setInterval(() => void checkForUpdate(), 60000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkForUpdate();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      if (cleanupSw) cleanupSw();
    };
  }, [checkForUpdate]);

  React.useEffect(() => {
    if (!updateAvailable) return;
    const timer = window.setTimeout(() => void reloadToLatest(), 12000);
    return () => window.clearTimeout(timer);
  }, [reloadToLatest, updateAvailable]);

  return (
    <>
      {updateAvailable && (
        <div className="update-banner">
          <span>Une nouvelle version est disponible.</span>
          <button onClick={() => void reloadToLatest()}>Actualiser</button>
        </div>
      )}
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/*" element={<AuthGate><App /></AuthGate>} />
        </Routes>
      </BrowserRouter>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UpdateAwareApp />
  </React.StrictMode>
);
