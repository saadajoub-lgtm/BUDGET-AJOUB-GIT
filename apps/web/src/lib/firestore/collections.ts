import { collection } from "firebase/firestore";
import { currentBudgetId, firestore } from "../firebase/client";

export function budgetDocCollections() {
  const budgetId = currentBudgetId();
  return {
    budgetId,
    accounts: collection(firestore, "budgets", budgetId, "accounts"),
    resources: collection(firestore, "budgets", budgetId, "resources"),
    charges: collection(firestore, "budgets", budgetId, "charges"),
    transfers: collection(firestore, "budgets", budgetId, "transfers"),
    histories: collection(firestore, "budgets", budgetId, "histories"),
    categories: collection(firestore, "budgets", budgetId, "categories"),
    labels: collection(firestore, "budgets", budgetId, "labels"),
    members: collection(firestore, "budgets", budgetId, "members")
  };
}
