import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  type User
} from "firebase/auth";
import { firebaseAuth } from "./client";

export function subscribeAuthState(callback: (user: User | null) => void) {
  return onAuthStateChanged(firebaseAuth, callback);
}

export async function firebaseLogin(email: string, password: string) {
  return signInWithEmailAndPassword(firebaseAuth, email, password);
}

export async function firebaseRegister(email: string, password: string) {
  return createUserWithEmailAndPassword(firebaseAuth, email, password);
}

export async function firebaseResetPassword(email: string) {
  return sendPasswordResetEmail(firebaseAuth, email);
}

export async function firebaseLogout() {
  return signOut(firebaseAuth);
}
