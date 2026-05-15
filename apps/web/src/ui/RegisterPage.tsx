import { useState } from "react";
import axios from "axios";
import { Link, useNavigate } from "react-router-dom";
import { firebaseRegister } from "../lib/firebase/auth";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? "http://localhost:4000" : window.location.origin);
const api = axios.create({ baseURL: API_BASE_URL, timeout: 8000 });

export function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const nav = useNavigate();

  const submit = async () => {
    setError("");
    try {
      await firebaseRegister(email, password);
      try {
        const res = await api.post("/auth/register", { email, password });
        if (res?.data?.token) localStorage.setItem("token", res.data.token);
      } catch {
        // API session is optional for Firebase registration; app can still open.
      }
      nav("/");
    } catch (e: any) {
      const code = String(e?.code ?? "");
      const message = String(e?.message ?? "");
      const name = String(e?.name ?? "");
      const asString = typeof e?.toString === "function" ? String(e.toString()) : "";
      if (code.includes("auth/email-already-in-use")) {
        setError("Cet email est deja utilise.");
        return;
      }
      if (code.includes("auth/invalid-email")) {
        setError("Adresse email invalide.");
        return;
      }
      if (code.includes("auth/weak-password")) {
        setError("Mot de passe trop faible (minimum 6 caracteres).");
        return;
      }
      if (code.includes("auth/operation-not-allowed")) {
        setError("Inscription desactivee sur Firebase (Email/Mot de passe).");
        return;
      }
      const technical = [code, message, name, asString].filter(Boolean).join(" | ");
      setError(`Impossible de creer le compte. (${technical || "erreur inconnue"})`);
    }
  };

  return (
    <div className="auth">
      <div className="card auth-card">
        <img className="auth-logo" src="/app-icon.png" alt="" width={72} height={72} />
        <h1>Creer un compte</h1>
        <p className="muted auth-subtitle">Creez un acces pour suivre le budget familial.</p>
        <input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="Mot de passe" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="error">{error}</div>}
        <button onClick={submit}>Creer mon compte</button>
        <Link to="/login"><button type="button" className="secondary">Retour connexion</button></Link>
      </div>
    </div>
  );
}
