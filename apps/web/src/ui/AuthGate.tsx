import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { subscribeAuthState } from "../lib/firebase/auth";
import type { User } from "firebase/auth";
import { claimInvitationsForCurrentUser, ensurePersonalBudget } from "../lib/firebase/budget";

export function AuthGate({ children }: { children: JSX.Element }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = subscribeAuthState((u) => {
      setUser(u);
      setLoading(false);
      if (!u) return;
      void (async () => {
        try {
          await ensurePersonalBudget();
          await claimInvitationsForCurrentUser();
        } catch (error) {
          console.error("AuthGate bootstrap error", error);
        }
      })();
    });
    return () => unsub();
  }, []);

  if (loading) {
    return (
      <div className="auth">
        <div className="card auth-card">
          <h1>Budget Ajoub</h1>
          <div className="muted">Verification de session...</div>
        </div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return children;
}
