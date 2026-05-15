import React, { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

type Props = {
  children: React.ReactNode;
  /** Mis à true quand les données principales (mois, comptes, charges, ressources, historique, tableau de bord) sont prêtes. */
  appReady: boolean;
};

/** Overlay au premier chargement (WebView / navigateur). */
export function SplashScreen({ children, appReady }: Props) {
  const [show, setShow] = useState(true);
  const [exiting, setExiting] = useState(false);
  const location = useLocation();
  const skipDataWait = /^\/(login|register|reset-password)\/?$/.test(location.pathname);

  useEffect(() => {
    if (!skipDataWait && !appReady) {
      setShow(true);
      setExiting(false);
    }
  }, [skipDataWait, appReady]);

  useEffect(() => {
    if (skipDataWait) {
      const fade = window.setTimeout(() => setExiting(true), 380);
      const hide = window.setTimeout(() => setShow(false), 780);
      return () => {
        window.clearTimeout(fade);
        window.clearTimeout(hide);
      };
    }
    if (!appReady) return;
    const fade = window.setTimeout(() => setExiting(true), 520);
    const hide = window.setTimeout(() => setShow(false), 980);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(hide);
    };
  }, [appReady, skipDataWait]);

  return (
    <>
      {children}
      {show ? (
        <div className={`app-splash${exiting ? " app-splash--out" : ""}`} aria-hidden="true">
          <div className="app-splash-inner">
            <img className="app-splash-logo" src="/app-icon.png" alt="" width={112} height={112} decoding="async" />
            <p className="app-splash-title">Budget Famille Ajoub</p>
            <p className="muted app-splash-sub">Chargement des donnees...</p>
          </div>
        </div>
      ) : null}
    </>
  );
}
