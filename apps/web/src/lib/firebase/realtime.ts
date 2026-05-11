import { addDoc, collection, onSnapshot, orderBy, query, serverTimestamp } from "firebase/firestore";
import { currentBudgetId, firestore } from "./client";

function syncCollectionPath() {
  return collection(firestore, "budgets", currentBudgetId(), "histories");
}

export async function publishSyncEvent(eventType: string) {
  await addDoc(syncCollectionPath(), {
    kind: "sync_event",
    eventType,
    createdAt: serverTimestamp()
  });
}

export function subscribeSyncEvents(callback: () => void) {
  const q = query(syncCollectionPath(), orderBy("createdAt", "desc"));
  return onSnapshot(q, () => callback());
}
