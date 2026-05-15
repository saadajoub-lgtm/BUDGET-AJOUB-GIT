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
        <img className="auth-logo" src="/app-icon.png" alt="" width={72} height={72} />
        <h1>Mot de passe oublie</h1>
        <p className="muted auth-subtitle">Recevez un lien pour recuperer votre acces.</p>
        <input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        {error && <div className="error">{error}</div>}
        {message && <div className="muted">{message}</div>}
        <button onClick={submit}>Envoyer le lien</button>
        <Link to="/login"><button type="button" className="secondary">Retour connexion</button></Link>
      </div>
    </div>
  );
}
