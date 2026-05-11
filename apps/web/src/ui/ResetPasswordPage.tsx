import { useState } from "react";
import { Link } from "react-router-dom";
import { firebaseResetPassword } from "../lib/firebase/auth";

export function ResetPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const submit = async () => {
    setError("");
    setMessage("");
    try {
      await firebaseResetPassword(email);
      setMessage("Email de reinitialisation envoye.");
    } catch {
      setError("Impossible d'envoyer l'email.");
    }
  };

  return (
    <div className="auth">
      <div className="card auth-card">
        <h1>Mot de passe oublie</h1>
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        {error && <div className="error">{error}</div>}
        {message && <div className="muted">{message}</div>}
        <button onClick={submit}>Envoyer le lien</button>
        <Link to="/login"><button type="button" className="secondary">Retour connexion</button></Link>
      </div>
    </div>
  );
}
