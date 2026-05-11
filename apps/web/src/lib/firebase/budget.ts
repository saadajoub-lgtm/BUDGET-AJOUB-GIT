import { addDoc, collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { firebaseAuth } from "./client";
import { firestore } from "./client";

export type BudgetRole = "owner" | "member";

export async function ensurePersonalBudget() {
  const user = firebaseAuth.currentUser;
  if (!user) return null;
  const budgetId = `budget-${user.uid}`;
  const budgetRef = doc(firestore, "budgets", budgetId);
  const budgetSnap = await getDoc(budgetRef).catch(() => null);
  if (!budgetSnap || !budgetSnap.exists()) {
    await setDoc(budgetRef, {
      name: "Budget principal",
      ownerUid: user.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }
  const memberRef = doc(firestore, "budgets", budgetId, "members", user.uid);
  await setDoc(
    memberRef,
    {
      uid: user.uid,
      email: user.email ?? "",
      role: "owner",
      addedAt: serverTimestamp()
    },
    { merge: true }
  );
  localStorage.setItem("budgetId", budgetId);
  return budgetId;
}

export async function inviteMemberByEmail(budgetId: string, email: string) {
  const invitations = collection(firestore, "budgets", budgetId, "members");
  await addDoc(invitations, {
    email: email.trim().toLowerCase(),
    role: "member" as BudgetRole,
    invitedAt: serverTimestamp(),
    invitedBy: firebaseAuth.currentUser?.uid ?? null,
    uid: null
  });
}

export async function listBudgetMembers(budgetId: string) {
  const rows = await getDocs(collection(firestore, "budgets", budgetId, "members"));
  return rows.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function claimInvitationsForCurrentUser() {
  const user = firebaseAuth.currentUser;
  if (!user?.email) return;
  const budgets = await getDocs(collection(firestore, "budgets"));
  for (const budget of budgets.docs) {
    const membersRef = collection(firestore, "budgets", budget.id, "members");
    const q = query(membersRef, where("email", "==", user.email.toLowerCase()), where("uid", "==", null));
    const matches = await getDocs(q);
    for (const m of matches.docs) {
      await setDoc(
        m.ref,
        {
          uid: user.uid,
          acceptedAt: serverTimestamp()
        },
        { merge: true }
      );
    }
  }
}
