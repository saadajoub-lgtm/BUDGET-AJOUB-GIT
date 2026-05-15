import { useState } from "react";
import axios from "axios";
import { Link, useNavigate } from "react-router-dom";
import { firebaseLogin } from "../lib/firebase/auth";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? "http://localhost:4000" : window.location.origin);
const api = axios.create({ baseURL: API_BASE_URL, timeout: 8000 });

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const nav = useNavigate();

  const submit = async () => {
    setError("");
    try {
      await firebaseLogin(email, password);
      try {
        const res = await api.post("/auth/login", { email, password });
        if (res?.data?.token) localStorage.setItem("token", res.data.token);
      } catch {
        // API session is optional for Firebase login; app can still open.
      }
      nav("/");
    } catch (e: any) {
      const code = String(e?.code ?? "");
      const message = String(e?.message ?? "");
      const name = String(e?.name ?? "");
      const asString = typeof e?.toString === "function" ? String(e.toString()) : "";
      if (code.includes("auth/invalid-credential") || code.includes("auth/wrong-password") || code.includes("auth/user-not-found")) {
        setError("Email ou mot de passe incorrect.");
        return;
      }
      if (code.includes("auth/invalid-email")) {
        setError("Adresse email invalide.");
        return;
      }
      const technical = [code, message, name, asString].filter(Boolean).join(" | ");
      setError(`Impossible de se connecter. (${technical || "erreur inconnue"})`);
    }
  };

  return (
    <div className="auth">
      <div className="card auth-card">
        <img className="auth-logo" src="/app-icon.png" alt="" width={72} height={72} />
        <h1>Connexion</h1>
        <p className="muted auth-subtitle">Accedez au tableau de bord Budget Famille Ajoub.</p>
        <input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="Mot de passe" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="error">{error}</div>}
        <button onClick={submit}>Se connecter</button>
        <Link to="/register"><button className="secondary" type="button">Creer un compte</button></Link>
        <Link to="/reset-password"><button className="secondary subtle" type="button">Mot de passe oublie</button></Link>
      </div>
    </div>
  );
}
