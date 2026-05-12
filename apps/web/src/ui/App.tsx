import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import axios from "axios";
import { io } from "socket.io-client";
import { Car, Gamepad2, HeartPulse, Home, Pencil, ReceiptText, ShoppingBasket, Smartphone, Trash2, Wallet, Wifi } from "lucide-react";
import { ACCOUNT_NAMES, RESOURCE_TYPES } from "@budget/shared";
import { firebaseLogout } from "../lib/firebase/auth";
import { publishSyncEvent, subscribeSyncEvents } from "../lib/firebase/realtime";
import { ensurePersonalBudget } from "../lib/firebase/budget";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
  where,
  type DocumentReference
} from "firebase/firestore";
import { currentBudgetId, firestore } from "../lib/firebase/client";

const FIREBASE_ONLY = (import.meta.env.VITE_FIREBASE_ONLY ?? "1") === "1";
/** Hébergement production : l’APK Capacitor ne tourne pas sur ce domaine, il faut la même base que le site en ligne pour les appels Axios (intercepteurs Firebase). */
const DEFAULT_PUBLIC_APP_ORIGIN = "https://budget-famille-ajoub.web.app";

function resolveFirebaseOnlyApiBaseUrl(): string {
  const fromEnv = String(import.meta.env.VITE_PUBLIC_APP_ORIGIN ?? "").trim();
  if (fromEnv) return fromEnv;
  if (Capacitor.isNativePlatform()) return DEFAULT_PUBLIC_APP_ORIGIN;
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  return DEFAULT_PUBLIC_APP_ORIGIN;
}

const API_BASE_URL = FIREBASE_ONLY
  ? resolveFirebaseOnlyApiBaseUrl()
  : (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? "http://localhost:4000" : window.location.origin));
const SOCKET_BASE_URL = FIREBASE_ONLY ? "" : (import.meta.env.VITE_SOCKET_URL || (import.meta.env.DEV ? "http://localhost:4000" : ""));

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: FIREBASE_ONLY ? 1200 : 8000
});

function budgetCollection(name: string) {
  return collection(firestore, "budgets", currentBudgetId(), name);
}

function extractEntityId(endpoint: string, entity: string) {
  const re = new RegExp(`/${entity}/([^/?#]+)/?$`);
  const m = re.exec(String(endpoint ?? ""));
  return m?.[1] ?? "";
}

/** POST /accounts/:accountId/set-balance — l'id n'est pas en fin d'URL, extractEntityId ne marche pas. */
function extractAccountIdFromSetBalanceEndpoint(path: string): string {
  const m = /^\/accounts\/([^/]+)\/set-balance\/?$/.exec(String(path ?? "").split("?")[0]);
  return m?.[1] ?? "";
}

function normalizeEndpoint(rawUrl: string) {
  const value = String(rawUrl ?? "");
  if (!value) return "";
  if (value.startsWith("/")) return value.split("?")[0];
  try {
    return new URL(value).pathname;
  } catch {
    const idx = value.indexOf("://");
    if (idx >= 0) {
      const slash = value.indexOf("/", idx + 3);
      if (slash >= 0) return value.slice(slash).split("?")[0];
    }
    return value.split("?")[0];
  }
}

function toMonthStartsAt(label: string) {
  return `${label}-01T00:00:00.000Z`;
}

let firestoreSeedPromise: Promise<void> | null = null;

async function ensureFirestoreSeed() {
  if (firestoreSeedPromise) {
    await firestoreSeedPromise;
    return;
  }
  firestoreSeedPromise = (async () => {
  await ensurePersonalBudget();
  const monthsSnap = await getDocs(query(budgetCollection("months"), orderBy("starts_at", "desc")));
  const allAccountsSnap = await getDocs(query(budgetCollection("accounts")));
  const existingByName = new Set(
    allAccountsSnap.docs.map((d) => normalizeTextForCompare(String((d.data() as any).name ?? ""))).filter(Boolean)
  );
  const ensureGlobalAccounts = async () => {
    for (const name of ACCOUNT_NAMES) {
      const key = normalizeTextForCompare(name);
      if (existingByName.has(key)) continue;
      const id = crypto.randomUUID();
      await setDoc(doc(budgetCollection("accounts"), id), {
        id,
        month_id: "global",
        name,
        balance_cents: 0
      });
      existingByName.add(key);
    }
  };
  if (!monthsSnap.empty) {
    await ensureGlobalAccounts();
    return;
  }
  const now = new Date();
  const label = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const monthId = crypto.randomUUID();
  await setDoc(doc(budgetCollection("months"), monthId), {
    id: monthId,
    label,
    starts_at: toMonthStartsAt(label),
    ends_at: toMonthStartsAt(label),
    created_at: new Date().toISOString()
  });
  await ensureGlobalAccounts();
  })().catch((err) => {
    firestoreSeedPromise = null;
    throw err;
  });
  await firestoreSeedPromise;
}

let augustToMayMigrationPromise: Promise<void> | null = null;
let augustToMayAccountsMigrationPromise: Promise<void> | null = null;
let septemberToMayResourcesMigrationPromise: Promise<void> | null = null;

async function migrateChargesAugustToMayOnce() {
  if (augustToMayMigrationPromise) {
    await augustToMayMigrationPromise;
    return;
  }
  augustToMayMigrationPromise = (async () => {
    await ensureFirestoreSeed();
    const budgetId = currentBudgetId();
    const migrationKey = `migration-2026-08-to-2026-05-${budgetId}`;
    if (localStorage.getItem(migrationKey) === "done") return;

    const monthsSnap = await getDocs(query(budgetCollection("months"), orderBy("starts_at", "desc")));
    const months = monthsSnap.docs.map((d) => d.data() as any);
    const mayLabel = "2026-05";
    const augLabel = "2026-08";

    let mayMonth = months.find((m) => normalizeMonthLabelKey(String(m.label ?? "")) === mayLabel);
    const augMonth = months.find((m) => normalizeMonthLabelKey(String(m.label ?? "")) === augLabel);
    if (!augMonth?.id) {
      localStorage.setItem(migrationKey, "done");
      return;
    }

    if (!mayMonth?.id) {
      const created = await firestoreCreateMonth(mayLabel);
      const refreshed = await getDocs(query(budgetCollection("months"), where("id", "==", created.id)));
      mayMonth = refreshed.docs[0]?.data() as any;
    }
    if (!mayMonth?.id) return;

    const chargesSnap = await getDocs(query(budgetCollection("charges"), where("month_id", "==", String(augMonth.id))));
    for (const chargeDoc of chargesSnap.docs) {
      const row = chargeDoc.data() as any;
      const expected = String(row.expected_date ?? "");
      let nextExpected = expected;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expected);
      if (m && `${m[1]}-${m[2]}` === augLabel) {
        nextExpected = `${mayLabel}-${m[3]}`;
      }
      await setDoc(
        chargeDoc.ref,
        {
          month_id: mayMonth.id,
          expected_date: nextExpected,
          updated_at: new Date().toISOString()
        },
        { merge: true }
      );
    }
    localStorage.setItem(migrationKey, "done");
  })().catch((err) => {
    augustToMayMigrationPromise = null;
    throw err;
  });
  await augustToMayMigrationPromise;
}

async function migrateAccountBalancesAugustToMayOnce() {
  if (augustToMayAccountsMigrationPromise) {
    await augustToMayAccountsMigrationPromise;
    return;
  }
  augustToMayAccountsMigrationPromise = (async () => {
    await ensureFirestoreSeed();
    const budgetId = currentBudgetId();
    const migrationKey = `migration-accounts-2026-09-to-2026-05-v3-${budgetId}`;
    if (localStorage.getItem(migrationKey) === "done") return;

    const monthsSnap = await getDocs(query(budgetCollection("months"), orderBy("starts_at", "desc")));
    const months = monthsSnap.docs.map((d) => d.data() as any);
    const mayMonth = months.find((m) => normalizeMonthLabelKey(String(m.label ?? "")) === "2026-05");
    const sourceMonth = months.find((m) => normalizeMonthLabelKey(String(m.label ?? "")) === "2026-09");
    if (!mayMonth?.id || !sourceMonth?.id) {
      localStorage.setItem(migrationKey, "done");
      return;
    }

    const [mayAccountsSnap, augAccountsSnap] = await Promise.all([
      getDocs(query(budgetCollection("accounts"), where("month_id", "==", String(mayMonth.id)))),
      getDocs(query(budgetCollection("accounts"), where("month_id", "==", String(sourceMonth.id))))
    ]);
    const mayByName = new Map<string, any[]>();
    for (const d of mayAccountsSnap.docs) {
      const row = d.data() as any;
      const key = String(row.name ?? "").trim().toUpperCase();
      if (!key) continue;
      mayByName.set(key, [...(mayByName.get(key) ?? []), row]);
    }
    const augByName = new Map<string, number>();

    for (const d of augAccountsSnap.docs) {
      const aug = d.data() as any;
      const nameKey = String(aug.name ?? "").trim().toUpperCase();
      if (!nameKey) continue;
      const nextBalance = Math.trunc(Number(aug.balance_cents ?? 0));
      augByName.set(nameKey, (augByName.get(nameKey) ?? 0) + nextBalance);
    }

    for (const [nameKey, nextBalance] of augByName.entries()) {
      const mayRows = mayByName.get(nameKey) ?? [];
      if (mayRows.length > 0) {
        for (const target of mayRows) {
          await setDoc(
            doc(budgetCollection("accounts"), String(target.id)),
            {
              balance_cents: nextBalance,
              updated_at: new Date().toISOString()
            },
            { merge: true }
          );
        }
      } else {
        const id = crypto.randomUUID();
        await setDoc(
          doc(budgetCollection("accounts"), id),
          {
            id,
            month_id: mayMonth.id,
            name: nameKey,
            balance_cents: nextBalance,
            updated_at: new Date().toISOString()
          },
          { merge: true }
        );
      }
    }

    localStorage.setItem(migrationKey, "done");
  })().catch((err) => {
    augustToMayAccountsMigrationPromise = null;
    throw err;
  });
  await augustToMayAccountsMigrationPromise;
}

async function migrateResourcesSeptemberToMayOnce() {
  if (septemberToMayResourcesMigrationPromise) {
    await septemberToMayResourcesMigrationPromise;
    return;
  }
  septemberToMayResourcesMigrationPromise = (async () => {
    await ensureFirestoreSeed();
    const budgetId = currentBudgetId();
    const migrationKey = `migration-resources-2026-09-to-2026-05-${budgetId}`;
    if (localStorage.getItem(migrationKey) === "done") return;

    const monthsSnap = await getDocs(query(budgetCollection("months"), orderBy("starts_at", "desc")));
    const months = monthsSnap.docs.map((d) => d.data() as any);
    const mayMonth = months.find((m) => normalizeMonthLabelKey(String(m.label ?? "")) === "2026-05");
    const sepMonth = months.find((m) => normalizeMonthLabelKey(String(m.label ?? "")) === "2026-09");
    if (!mayMonth?.id || !sepMonth?.id) {
      localStorage.setItem(migrationKey, "done");
      return;
    }

    const resourcesSnap = await getDocs(query(budgetCollection("resources"), where("month_id", "==", String(sepMonth.id))));
    for (const resourceDoc of resourcesSnap.docs) {
      const row = resourceDoc.data() as any;
      const expected = String(row.expected_date ?? "");
      let nextExpected = expected;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expected);
      if (m && `${m[1]}-${m[2]}` === "2026-09") {
        nextExpected = `2026-05-${m[3]}`;
      }
      await setDoc(
        resourceDoc.ref,
        {
          month_id: mayMonth.id,
          expected_date: nextExpected,
          updated_at: new Date().toISOString()
        },
        { merge: true }
      );
    }

    localStorage.setItem(migrationKey, "done");
  })().catch((err) => {
    septemberToMayResourcesMigrationPromise = null;
    throw err;
  });
  await septemberToMayResourcesMigrationPromise;
}

async function getGlobalAccounts() {
  const snap = await getDocs(query(budgetCollection("accounts")));
  const rows = snap.docs.map((d) => d.data() as any).sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
  const byName = new Map<string, any>();
  for (const row of rows) {
    const key = normalizeTextForCompare(String(row.name ?? ""));
    if (!key) continue;
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, row);
      continue;
    }
    // Plusieurs documents pour le même nom : garder le plus récemment mis à jour (ex. solde manuel).
    const tNew = String(row.updated_at ?? "");
    const tOld = String(existing.updated_at ?? "");
    if (tNew >= tOld) byName.set(key, row);
  }
  return Array.from(byName.values()).sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
}

async function firestoreGet(url: string) {
  await ensureFirestoreSeed();
  await migrateChargesAugustToMayOnce();
  await migrateAccountBalancesAugustToMayOnce();
  await migrateResourcesSeptemberToMayOnce();
  if (url === "/months") {
    const snap = await getDocs(query(budgetCollection("months"), orderBy("starts_at", "desc")));
    return snap.docs.map((d) => d.data());
  }
  if (url.startsWith("/accounts/")) {
    return getGlobalAccounts();
  }
  if (url.startsWith("/resources/")) {
    const monthId = url.split("/")[2];
    const snap = await getDocs(query(budgetCollection("resources"), where("month_id", "==", monthId)));
    return snap.docs.map((d) => d.data());
  }
  if (url.startsWith("/charges/")) {
    if (/^\/charges\/[^/?#]+\/annual-history\/?$/.test(url)) {
      const chargeId = url.split("/")[2];
      const chargeDoc = await getDoc(doc(budgetCollection("charges"), chargeId));
      const charge = chargeDoc.exists() ? (chargeDoc.data() as any) : null;
      if (!charge?.id) return [];
      const targetLabel = String(charge.label ?? "").trim().toLowerCase();
      if (!targetLabel) return [];
      const monthsSnap = await getDocs(query(budgetCollection("months"), orderBy("starts_at", "desc")));
      const monthById = new Map<string, any>();
      for (const d of monthsSnap.docs) {
        const row = d.data() as any;
        monthById.set(String(row.id), row);
      }
      const chargesSnap = await getDocs(query(budgetCollection("charges"), orderBy("expected_date", "desc")));
      return chargesSnap.docs
        .map((d) => d.data() as any)
        .filter((c) => String(c.label ?? "").trim().toLowerCase() === targetLabel)
        .filter((c) => Number(c.paid_cents ?? 0) > 0 || String(c.status ?? "") === "payee")
        .slice(0, 60)
        .map((c) => ({
          ...c,
          month_label: String(monthById.get(String(c.month_id ?? ""))?.label ?? "")
        }));
    }
    if (/^\/charges\/[^/?#]+\/payments\/?$/.test(url)) {
      const chargeId = url.split("/")[2];
      return firestoreGetChargePayments(chargeId);
    }
    const monthId = url.split("/")[2];
    const snap = await getDocs(query(budgetCollection("charges"), where("month_id", "==", monthId)));
    return snap.docs.map((d) => d.data());
  }
  if (url.startsWith("/history/")) {
    const monthId = url.split("/")[2];
    const snap = await getDocs(query(budgetCollection("histories"), where("month_id", "==", monthId)));
    return snap.docs.map((d) => d.data());
  }
  if (url.startsWith("/dashboard/")) {
    const monthId = url.split("/")[2];
    const [accounts, resourcesSnap, chargesSnap] = await Promise.all([
      getGlobalAccounts(),
      getDocs(query(budgetCollection("resources"), where("month_id", "==", monthId))),
      getDocs(query(budgetCollection("charges"), where("month_id", "==", monthId)))
    ]);
    const resources = resourcesSnap.docs.map((d) => d.data() as any);
    const charges = chargesSnap.docs.map((d) => d.data() as any);
    const isEpargneAccount = (a: any) => normalizeTextForCompare(String(a.name ?? "")) === "EPARGNE";
    // Solde à jour et solde fin de mois : hors compte EPARGNE (affiché à part, aligné sur l’API SQLite).
    const soldeActuel = accounts
      .filter((a) => !isEpargneAccount(a))
      .reduce((s, a) => s + Number(a.balance_cents ?? 0), 0);
    const epargne = accounts.filter(isEpargneAccount).reduce((s, a) => s + Number(a.balance_cents ?? 0), 0);
    const ressourcesAVenir = resources
      .filter((r) => isPrevueRowStatus(r.status))
      .reduce((s, r) => s + Math.round(Number(r.amount_cents ?? r.amountCents ?? 0)), 0);
    const chargesAVenir = charges.filter(isChargeAVenirForDashboard).reduce((s, c) => s + chargeRemainingDueCents(c), 0);
    const soldeFinMoisPrevu = computeSoldeFinMoisPrevuFromKpis(soldeActuel, ressourcesAVenir, chargesAVenir);
    return {
      soldeActuel,
      epargne,
      ressourcesAVenir,
      chargesAVenir,
      soldeFinMoisPrevu
    };
  }
  throw new Error("Endpoint non supporté en mode Firebase-only");
}

async function firestoreCreateMonth(label: string) {
  await ensureFirestoreSeed();
  const key = normalizeMonthLabelKey(label);
  const existingSnap = await getDocs(query(budgetCollection("months"), where("label", "==", key)));
  const existing = existingSnap.docs[0]?.data() as any;
  if (existing?.id) return { id: existing.id };

  const monthId = crypto.randomUUID();
  const startsAt = toMonthStartsAt(key);
  await setDoc(doc(budgetCollection("months"), monthId), {
    id: monthId,
    label: key,
    starts_at: startsAt,
    ends_at: startsAt,
    created_at: new Date().toISOString()
  });

  // Accounts are global (not per-month). Month creation should not clone account balances.
  const targetChargesSnap = await getDocs(query(budgetCollection("charges"), where("month_id", "==", monthId)));
  const targetResourcesSnap = await getDocs(query(budgetCollection("resources"), where("month_id", "==", monthId)));
  const existingChargeRoots = new Set(targetChargesSnap.docs.map((d) => String((d.data() as any).recurrence_root ?? "")));
  const existingResourceRoots = new Set(targetResourcesSnap.docs.map((d) => String((d.data() as any).recurrence_root ?? "")));
  const [allRecurringCharges, allRecurringResources] = await Promise.all([
    getDocs(query(budgetCollection("charges"), where("is_recurrent", "==", true))),
    getDocs(query(budgetCollection("resources"), where("is_recurrent", "==", true)))
  ]);
  for (const d of allRecurringCharges.docs) {
    const row = d.data() as any;
    const root = String(row.recurrence_root ?? row.id ?? "");
    const frequency = String(row.recurrence_frequency ?? "monthly") as RecurrenceFrequency;
    const baseDate = String(row.expected_date ?? "");
    if (!root || existingChargeRoots.has(root)) continue;
    if (!shouldGenerateRecurring(baseDate, key, frequency)) continue;
    const id = crypto.randomUUID();
    await setDoc(doc(budgetCollection("charges"), id), {
      id,
      month_id: monthId,
      label: String(row.label ?? ""),
      category: String(row.category ?? ""),
      amount_cents: Math.max(0, Math.trunc(Number(row.amount_cents ?? 0))),
      paid_cents: 0,
      account_id: row.account_id ? String(row.account_id) : null,
      expected_date: remapDateToTargetMonth(baseDate, key),
      status: "prevue",
      payment_mode: "",
      note: String(row.note ?? ""),
      charge_type: String(row.charge_type ?? "totale"),
      is_recurrent: true,
      recurrence_frequency: frequency,
      recurrence_root: root,
      generated_automatically: true
    });
    existingChargeRoots.add(root);
  }
  for (const d of allRecurringResources.docs) {
    const row = d.data() as any;
    const root = String(row.recurrence_root ?? row.id ?? "");
    const frequency = String(row.recurrence_frequency ?? "monthly") as RecurrenceFrequency;
    const baseDate = String(row.expected_date ?? "");
    if (!root || existingResourceRoots.has(root)) continue;
    if (!shouldGenerateRecurring(baseDate, key, frequency)) continue;
    const id = crypto.randomUUID();
    await setDoc(doc(budgetCollection("resources"), id), {
      id,
      month_id: monthId,
      type: String(row.type ?? ""),
      amount_cents: Math.max(0, Math.trunc(Number(row.amount_cents ?? 0))),
      account_id: String(row.account_id ?? ""),
      expected_date: remapDateToTargetMonth(baseDate, key),
      status: "prevue",
      note: String(row.note ?? ""),
      is_recurrent: true,
      recurrence_frequency: frequency,
      recurrence_root: root,
      generated_automatically: true
    });
    existingResourceRoots.add(root);
  }
  return { id: monthId };
}

async function firestoreSetAccountBalance(accountId: string, payload: any) {
  const next = Number(payload?.newBalanceCents ?? 0);
  const accountRef = doc(budgetCollection("accounts"), accountId);
  await setDoc(
    accountRef,
    {
      balance_cents: Number.isFinite(next) ? Math.trunc(next) : 0,
      updated_at: new Date().toISOString()
    },
    { merge: true }
  );
  const adjustmentId = crypto.randomUUID();
  await setDoc(doc(budgetCollection("histories"), adjustmentId), {
    id: adjustmentId,
    month_id: String(payload?.monthId ?? ""),
    account_id: accountId,
    amount_cents: Number.isFinite(next) ? Math.trunc(next) : 0,
    created_at: String(payload?.adjustmentDate ?? new Date().toISOString()),
    category: "ajustement",
    status: "effectue",
    operation_group: "other",
    note: String(payload?.note ?? "Modification manuelle")
  });
  return { ok: true };
}

async function firestoreCreateCharge(payload: any) {
  await ensureFirestoreSeed();
  const id = crypto.randomUUID();
  const monthId = String(payload?.monthId ?? "");
  const amountCents = Math.max(0, Math.trunc(Number(payload?.amountCents ?? 0)));
  const expectedDate = String(payload?.expectedDate ?? "");
  const label = String(payload?.label ?? "").trim();
  const category = String(payload?.category ?? "").trim();
  const note = String(payload?.note ?? "");
  const chargeType = String(payload?.chargeType ?? "totale");
  const accountId = payload?.accountId ? String(payload.accountId) : null;
  const isRecurrent = Boolean(payload?.isRecurrent);
  const recurrenceFrequency = String(payload?.recurrenceFrequency ?? "monthly") as RecurrenceFrequency;

  await setDoc(doc(budgetCollection("charges"), id), {
    id,
    month_id: monthId,
    label,
    category,
    amount_cents: amountCents,
    paid_cents: 0,
    account_id: accountId,
    expected_date: expectedDate,
    status: "prevue",
    payment_mode: "",
    note,
    charge_type: chargeType,
    is_recurrent: isRecurrent,
    recurrence_frequency: recurrenceFrequency,
    recurrence_root: isRecurrent ? id : null
  });
  return { id };
}

async function firestoreUpdateCharge(chargeId: string, payload: any) {
  await ensureFirestoreSeed();
  const amountCents = Math.max(0, Math.trunc(Number(payload?.amountCents ?? 0)));
  const expectedDate = String(payload?.expectedDate ?? "");
  const patch: Record<string, unknown> = {
    label: String(payload?.label ?? "").trim(),
    category: String(payload?.category ?? "").trim(),
    amount_cents: amountCents,
    account_id: payload?.accountId ? String(payload.accountId) : null,
    expected_date: expectedDate,
    note: String(payload?.note ?? ""),
    charge_type: String(payload?.chargeType ?? "totale"),
    is_recurrent: Boolean(payload?.isRecurrent),
    recurrence_frequency: String(payload?.recurrenceFrequency ?? "monthly"),
    updated_at: new Date().toISOString()
  };
  await setDoc(doc(budgetCollection("charges"), chargeId), patch, { merge: true });
  if (Boolean(payload?.isRecurrent)) {
    await setDoc(doc(budgetCollection("charges"), chargeId), { recurrence_root: String(payload?.recurrenceRoot ?? chargeId) }, { merge: true });
  }
  return { ok: true };
}

async function firestoreDeleteCharge(chargeId: string) {
  await ensureFirestoreSeed();
  const chargeRef = doc(budgetCollection("charges"), chargeId);
  await deleteDoc(chargeRef);

  // Cleanup related history/payment documents if they exist in the same budget.
  const historiesSnap = await getDocs(query(budgetCollection("histories"), where("charge_id", "==", chargeId)));
  for (const d of historiesSnap.docs) {
    await deleteDoc(d.ref);
  }
  const paymentsSnap = await getDocs(query(budgetCollection("charge_payments"), where("charge_id", "==", chargeId)));
  for (const d of paymentsSnap.docs) {
    await deleteDoc(d.ref);
  }
  return { ok: true };
}

async function firestoreDeleteResource(resourceId: string) {
  await ensureFirestoreSeed();
  const resourceRef = doc(budgetCollection("resources"), resourceId);
  let docSnap = await getDoc(resourceRef);
  let row = docSnap.exists() ? (docSnap.data() as any) : null;
  let refToDelete: DocumentReference = resourceRef;
  if (!row?.id) {
    const qsnap = await getDocs(query(budgetCollection("resources"), where("id", "==", resourceId)));
    const d = qsnap.docs[0];
    if (!d) throw new Error("Ressource introuvable");
    refToDelete = d.ref;
    row = d.data() as any;
  }
  const oldStatus = String(row.status ?? "prevue").toLowerCase();
  const amountCents = Math.max(0, Math.trunc(Number(row.amount_cents ?? 0)));
  const accountId = String(row.account_id ?? "").trim();
  if (oldStatus === "recue" && accountId && amountCents > 0) {
    const accountRef = doc(budgetCollection("accounts"), accountId);
    const accSnap = await getDoc(accountRef);
    if (accSnap.exists()) {
      const cur = Math.trunc(Number((accSnap.data() as any)?.balance_cents ?? 0));
      await setDoc(accountRef, { balance_cents: cur - amountCents, updated_at: new Date().toISOString() }, { merge: true });
    } else {
      const qs = await getDocs(query(budgetCollection("accounts"), where("id", "==", accountId)));
      const ad = qs.docs[0];
      if (ad) {
        const cur = Math.trunc(Number((ad.data() as any)?.balance_cents ?? 0));
        await setDoc(ad.ref, { balance_cents: cur - amountCents, updated_at: new Date().toISOString() }, { merge: true });
      }
    }
  }
  await deleteDoc(refToDelete);
  return { ok: true };
}

async function firestoreCreateResource(payload: any) {
  await ensureFirestoreSeed();
  const id = crypto.randomUUID();
  const monthId = String(payload?.monthId ?? "");
  const type = String(payload?.type ?? "");
  const amountCents = Math.max(0, Math.trunc(Number(payload?.amountCents ?? 0)));
  const accountId = String(payload?.accountId ?? "");
  const expectedDate = String(payload?.expectedDate ?? "");
  const status = String(payload?.status ?? "prevue");
  const note = String(payload?.note ?? "");
  const isRecurrent = Boolean(payload?.isRecurrent);
  const recurrenceFrequency = String(payload?.recurrenceFrequency ?? "monthly") as RecurrenceFrequency;

  await setDoc(doc(budgetCollection("resources"), id), {
    id,
    month_id: monthId,
    type,
    amount_cents: amountCents,
    account_id: accountId,
    expected_date: expectedDate,
    status,
    note,
    is_recurrent: isRecurrent,
    recurrence_frequency: recurrenceFrequency,
    recurrence_root: isRecurrent ? id : null
  });

  // Keep account balance behavior aligned with existing API rule:
  // resource affects account only when marked as received.
  if (status === "recue" && accountId) {
    const accountRef = doc(budgetCollection("accounts"), accountId);
    let cur = 0;
    const direct = await getDoc(accountRef);
    if (direct.exists()) {
      cur = Math.trunc(Number((direct.data() as any)?.balance_cents ?? 0));
    } else {
      const accountSnap = await getDocs(query(budgetCollection("accounts"), where("id", "==", accountId)));
      const row = accountSnap.docs[0]?.data() as any;
      cur = Math.trunc(Number(row?.balance_cents ?? 0));
    }
    const next = cur + amountCents;
    await setDoc(accountRef, { balance_cents: next, updated_at: new Date().toISOString() }, { merge: true });
  }
  return { id };
}

/** Marque une ressource « recue » / « prevue » et ajuste le solde du compte lié (mode Firebase-only). */
async function firestorePatchResourceStatus(resourceId: string, payload: { status?: string }) {
  await ensureFirestoreSeed();
  const newStatus = String(payload?.status ?? "").toLowerCase();
  if (newStatus !== "recue" && newStatus !== "prevue") throw new Error("Statut invalide");

  const resourceRef = doc(budgetCollection("resources"), resourceId);
  let resourceSnap = await getDoc(resourceRef);
  let row = resourceSnap.exists() ? (resourceSnap.data() as any) : null;
  if (!row?.id) {
    const qsnap = await getDocs(query(budgetCollection("resources"), where("id", "==", resourceId)));
    row = qsnap.docs[0]?.data() as any;
  }
  if (!row?.id) throw new Error("Ressource introuvable");

  const oldStatus = String(row.status ?? "prevue").toLowerCase();
  const amountCents = Math.max(0, Math.trunc(Number(row.amount_cents ?? 0)));
  const accountId = String(row.account_id ?? "").trim();

  async function readAccountBalance(aid: string): Promise<{ ref: DocumentReference; balance: number } | null> {
    const accountRef = doc(budgetCollection("accounts"), aid);
    const direct = await getDoc(accountRef);
    if (direct.exists()) {
      return { ref: accountRef, balance: Math.trunc(Number((direct.data() as any)?.balance_cents ?? 0)) };
    }
    const qs = await getDocs(query(budgetCollection("accounts"), where("id", "==", aid)));
    const d = qs.docs[0];
    if (!d) return null;
    return { ref: d.ref, balance: Math.trunc(Number((d.data() as any)?.balance_cents ?? 0)) };
  }

  if (newStatus === "recue" && oldStatus !== "recue") {
    if (!accountId) throw new Error("Associez un compte a la ressource avant de marquer recue.");
    const acc = await readAccountBalance(accountId);
    if (!acc) throw new Error("Compte introuvable.");
    await setDoc(acc.ref, { balance_cents: acc.balance + amountCents, updated_at: new Date().toISOString() }, { merge: true });
  } else if (newStatus === "prevue" && oldStatus === "recue") {
    if (accountId) {
      const acc = await readAccountBalance(accountId);
      if (acc) {
        await setDoc(acc.ref, { balance_cents: acc.balance - amountCents, updated_at: new Date().toISOString() }, { merge: true });
      }
    }
  }

  await setDoc(resourceRef, { status: newStatus, updated_at: new Date().toISOString() }, { merge: true });
  return { ok: true };
}

async function firestoreUpdateResource(resourceId: string, payload: any) {
  await ensureFirestoreSeed();
  const patch: Record<string, unknown> = {
    type: String(payload?.type ?? ""),
    amount_cents: Math.max(0, Math.trunc(Number(payload?.amountCents ?? 0))),
    account_id: String(payload?.accountId ?? ""),
    expected_date: String(payload?.expectedDate ?? ""),
    is_recurrent: Boolean(payload?.isRecurrent),
    recurrence_frequency: String(payload?.recurrenceFrequency ?? "monthly"),
    updated_at: new Date().toISOString()
  };
  await setDoc(doc(budgetCollection("resources"), resourceId), patch, { merge: true });
  return { ok: true };
}

async function firestoreGetChargePayments(chargeId: string) {
  const paymentsSnap = await getDocs(query(budgetCollection("charge_payments"), where("charge_id", "==", chargeId)));
  const payments = paymentsSnap.docs.map((d) => d.data() as any);
  const accountIds = Array.from(new Set(payments.map((p) => String(p.account_id ?? "")).filter(Boolean)));
  const accountNameById = new Map<string, string>();
  for (const accountId of accountIds) {
    const accountSnap = await getDocs(query(budgetCollection("accounts"), where("id", "==", accountId)));
    const row = accountSnap.docs[0]?.data() as any;
    if (row?.id) accountNameById.set(String(row.id), String(row.name ?? "-"));
  }
  return payments
    .map((p) => ({
      ...p,
      account_name: accountNameById.get(String(p.account_id ?? "")) ?? "-"
    }))
    .sort((a, b) => String(b.payment_date ?? b.created_at ?? "").localeCompare(String(a.payment_date ?? a.created_at ?? "")));
}

/** Charge « épargne » : libellé ou catégorie contient epargne/épargne. À chaque paiement, le montant payé est aussi crédité sur le compte EPARGNE. */
function isChargeEpargneVersement(charge: { label?: unknown; category?: unknown }) {
  const blob = normalizeTextForCompare(`${String(charge.category ?? "")} ${String(charge.label ?? "")}`);
  return blob.includes("EPARGNE");
}

async function firestoreAddChargePayment(
  chargeId: string,
  payload: any,
  options?: { onStep?: (step: string) => void }
) {
  const onStep = options?.onStep ?? (() => {});
  onStep("Verification du montant");
  await ensureFirestoreSeed();
  onStep("Recherche de la charge");
  const chargeDoc = await getDoc(doc(budgetCollection("charges"), chargeId));
  let charge = chargeDoc.exists() ? (chargeDoc.data() as any) : null;
  if (!charge?.id) {
    const chargeSnap = await getDocs(query(budgetCollection("charges"), where("id", "==", chargeId)));
    charge = chargeSnap.docs[0]?.data() as any;
  }
  if (!charge?.id) throw new Error("Charge introuvable");

  const monthId = String(charge.month_id ?? "");
  const amountCentsRaw = Math.trunc(Number(payload?.amountCents ?? 0));
  const amountCents = Math.max(0, amountCentsRaw);
  if (!amountCents) throw new Error("Montant invalide");
  const accountId = String(payload?.accountId ?? "");
  if (!accountId) throw new Error("Compte de paiement requis");
  const paymentMode = String(payload?.paymentMode ?? "autre");
  const paymentDate = String(payload?.paymentDate ?? new Date().toISOString());
  const note = String(payload?.note ?? "");

  onStep("Recherche du compte source");
  const sourceDoc = await getDoc(doc(budgetCollection("accounts"), accountId));
  let source = sourceDoc.exists() ? (sourceDoc.data() as any) : null;
  if (!source?.id) {
    const sourceSnap = await getDocs(query(budgetCollection("accounts"), where("id", "==", accountId)));
    source = sourceSnap.docs[0]?.data() as any;
  }
  if (!source?.id) throw new Error("Compte source introuvable");

  const paidBefore = Number(charge.paid_cents ?? 0);
  const total = Number(charge.amount_cents ?? 0);
  const remaining = Math.max(0, total - paidBefore);
  const effectiveAmount = Math.min(amountCents, remaining || amountCents);
  if (!effectiveAmount) throw new Error("Charge deja reglee");

  const isEpargneCharge = isChargeEpargneVersement(charge);
  const isProgressive = String(charge.charge_type ?? "totale") === "progressive";
  if (isEpargneCharge || isProgressive) {
    onStep("Mode simplifie actif: traitement normal temporaire");
  }
  let epargneAccountId = "";
  if (isEpargneCharge) {
    onStep("Recherche compte Epargne");
    const accountsGlobal = await getGlobalAccounts();
    const epargne = accountsGlobal.find((a) => normalizeTextForCompare(String(a.name ?? "")) === "EPARGNE");
    if (!epargne?.id) throw new Error("Compte Epargne introuvable pour ce mois");
    epargneAccountId = String(epargne.id);
  }

  const paymentId = crypto.randomUUID();
  const historyDebitId = crypto.randomUUID();
  const chargeRef = doc(budgetCollection("charges"), chargeId);
  const sourceRef = doc(budgetCollection("accounts"), String(source.id));
  const paymentRef = doc(budgetCollection("charge_payments"), paymentId);
  const historyDebitRef = doc(budgetCollection("histories"), historyDebitId);
  const paidAfter = paidBefore + effectiveAmount;
  // Etape A: debit source
  onStep("Debit du compte source");
  try {
    await setDoc(
      sourceRef,
      {
        balance_cents: Math.trunc(Number(source.balance_cents ?? 0)) - effectiveAmount,
        updated_at: new Date().toISOString()
      },
      { merge: true }
    );
  } catch (e: any) {
    throw new Error(`Etape A echec (debit compte source): ${String(e?.message ?? e)}`);
  }
  if (isEpargneCharge && epargneAccountId) {
    onStep("Credit epargne si charge epargne");
    try {
      const epargneDoc = await getDoc(doc(budgetCollection("accounts"), epargneAccountId));
      if (!epargneDoc.exists()) throw new Error("Compte Epargne introuvable");
      const epargneRow = epargneDoc.data() as any;
      await setDoc(
        doc(budgetCollection("accounts"), epargneAccountId),
        {
          balance_cents: Math.trunc(Number(epargneRow.balance_cents ?? 0)) + effectiveAmount,
          updated_at: new Date().toISOString()
        },
        { merge: true }
      );
    } catch (e: any) {
      throw new Error(`Etape A2 echec (credit epargne): ${String(e?.message ?? e)}`);
    }
  }
  // Etape B: update charge
  onStep("Mise a jour de la charge");
  try {
    await setDoc(
      chargeRef,
      {
        paid_cents: paidAfter,
        status: paidAfter >= total ? "payee" : "prevue",
        isPaid: paidAfter >= total,
        payment_mode: paymentMode,
        account_id: accountId,
        updated_at: new Date().toISOString()
      },
      { merge: true }
    );
  } catch (e: any) {
    throw new Error(`Etape B echec (mise a jour charge): ${String(e?.message ?? e)}`);
  }
  // Etape C: payment + history
  onStep("Creation du paiement");
  try {
    await setDoc(paymentRef, {
      id: paymentId,
      charge_id: chargeId,
      month_id: monthId,
      account_id: accountId,
      amount_cents: effectiveAmount,
      payment_mode: paymentMode,
      payment_date: paymentDate,
      note,
      created_at: new Date().toISOString()
    });
  } catch (e: any) {
    throw new Error(`Etape C echec (creation payment): ${String(e?.message ?? e)}`);
  }
  onStep("Creation historique");
  try {
    await setDoc(historyDebitRef, {
      id: historyDebitId,
      month_id: monthId,
      account_id: accountId,
      charge_id: chargeId,
      amount_cents: -effectiveAmount,
      created_at: paymentDate,
      category: isEpargneCharge ? "epargne" : "charge",
      status: "effectue",
      operation_group: isEpargneCharge ? "transfer" : "charge",
      note: isEpargneCharge ? `Versement vers Epargne - ${String(charge.label ?? "Charge")}` : `Paiement charge - ${String(charge.label ?? "Charge")}`
    });
    if (isEpargneCharge && epargneAccountId) {
      const historyCreditId = crypto.randomUUID();
      await setDoc(doc(budgetCollection("histories"), historyCreditId), {
        id: historyCreditId,
        month_id: monthId,
        account_id: epargneAccountId,
        charge_id: chargeId,
        amount_cents: effectiveAmount,
        created_at: paymentDate,
        category: "epargne",
        status: "effectue",
        operation_group: "transfer",
        note: `Versement vers Epargne depuis ${String(source.name ?? "Compte")}`
      });
    }
  } catch (e: any) {
    throw new Error(`Etape C echec (creation historique): ${String(e?.message ?? e)}`);
  }
  return { ok: true, paid_cents: paidAfter, status: paidAfter >= total ? "payee" : "prevue", isPaid: paidAfter >= total };
}

async function firestoreApplyRecurringRuleToFuture(
  kind: "charges" | "resources",
  recurrenceRoot: string,
  currentMonthId: string,
  fields: Record<string, unknown>
) {
  if (!recurrenceRoot || !currentMonthId) return;
  const monthsSnap = await getDocs(query(budgetCollection("months"), orderBy("starts_at", "asc")));
  const labelById = new Map<string, string>();
  for (const d of monthsSnap.docs) {
    const row = d.data() as any;
    labelById.set(String(row.id), normalizeMonthLabelKey(String(row.label ?? "")));
  }
  const currentLabel = labelById.get(currentMonthId);
  if (!currentLabel) return;
  const allSnap = await getDocs(query(budgetCollection(kind), where("recurrence_root", "==", recurrenceRoot)));
  for (const d of allSnap.docs) {
    const row = d.data() as any;
    const rowLabel = labelById.get(String(row.month_id ?? ""));
    if (!rowLabel || rowLabel < currentLabel) continue;
    const isFuture = rowLabel > currentLabel;
    const patch = { ...fields } as Record<string, unknown>;
    if (kind === "charges" && isFuture) {
      patch.status = "prevue";
      patch.paid_cents = 0;
      patch.expected_date = remapDateToTargetMonth(String(fields.expected_date ?? row.expected_date ?? ""), rowLabel);
    }
    if (kind === "resources" && isFuture) {
      patch.status = "prevue";
      patch.expected_date = remapDateToTargetMonth(String(fields.expected_date ?? row.expected_date ?? ""), rowLabel);
    }
    await setDoc(doc(budgetCollection(kind), String(row.id)), patch, { merge: true });
  }
}
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
api.interceptors.response.use(
  async (response) => {
    if (FIREBASE_ONLY) {
      const method = String(response.config.method ?? "").toLowerCase();
      const endpoint = normalizeEndpoint(String(response.config.url ?? ""));
      if (method === "get") {
        const data = await firestoreGet(endpoint);
        return {
          ...response,
          data
        };
      }
      if (method === "post" && endpoint === "/months") {
        const payload = typeof response.config?.data === "string" ? JSON.parse(response.config.data) : (response.config?.data ?? {});
        const data = await firestoreCreateMonth(String(payload.label ?? ""));
        return {
          ...response,
          status: 201,
          statusText: "Created",
          data
        };
      }
      if (method === "post" && endpoint === "/charges") {
        const payload = typeof response.config?.data === "string" ? JSON.parse(response.config.data) : (response.config?.data ?? {});
        const data = await firestoreCreateCharge(payload);
        return {
          ...response,
          status: 201,
          statusText: "Created",
          data
        };
      }
      if (method === "post" && endpoint === "/resources") {
        const payload = typeof response.config?.data === "string" ? JSON.parse(response.config.data) : (response.config?.data ?? {});
        const data = await firestoreCreateResource(payload);
        return {
          ...response,
          status: 201,
          statusText: "Created",
          data
        };
      }
      if (method === "post" && /\/charges\/[^/?#]+\/payments\/?$/.test(endpoint)) {
        const payload = typeof response.config?.data === "string" ? JSON.parse(response.config.data) : (response.config?.data ?? {});
        const chargeId = endpoint.split("/")[2] ?? "";
        if (!chargeId) throw new Error("Charge id introuvable");
        const data = await firestoreAddChargePayment(chargeId, payload);
        return {
          ...response,
          status: 201,
          statusText: "Created",
          data
        };
      }
      if (method === "put" && /\/charges\/[^/?#]+\/?$/.test(endpoint)) {
        const payload = typeof response.config?.data === "string" ? JSON.parse(response.config.data) : (response.config?.data ?? {});
        const chargeId = extractEntityId(endpoint, "charges");
        if (!chargeId) throw new Error("Charge id introuvable");
        const data = await firestoreUpdateCharge(chargeId, payload);
        return {
          ...response,
          data
        };
      }
      if (method === "put" && /\/resources\/[^/?#]+\/?$/.test(endpoint)) {
        const payload = typeof response.config?.data === "string" ? JSON.parse(response.config.data) : (response.config?.data ?? {});
        const resourceId = extractEntityId(endpoint, "resources");
        if (!resourceId) throw new Error("Resource id introuvable");
        const data = await firestoreUpdateResource(resourceId, payload);
        return {
          ...response,
          data
        };
      }
      if (method === "patch" && /\/resources\/[^/]+\/status\/?$/.test(endpoint)) {
        const payload = typeof response.config?.data === "string" ? JSON.parse(response.config.data) : (response.config?.data ?? {});
        const m = /^\/resources\/([^/]+)\/status\/?$/.exec(endpoint);
        const resourceId = m?.[1] ?? "";
        if (!resourceId) throw new Error("Resource id introuvable");
        const data = await firestorePatchResourceStatus(resourceId, payload);
        return {
          ...response,
          status: 200,
          statusText: "OK",
          data
        };
      }
      if (method === "delete" && /\/charges\/[^/?#]+\/?$/.test(endpoint)) {
        const chargeId = extractEntityId(endpoint, "charges");
        if (!chargeId) throw new Error("Charge id introuvable");
        const data = await firestoreDeleteCharge(chargeId);
        return {
          ...response,
          data
        };
      }
      if (method === "delete" && /\/resources\/[^/?#]+\/?$/.test(endpoint)) {
        const resourceId = extractEntityId(endpoint, "resources");
        if (!resourceId) throw new Error("Resource id introuvable");
        const data = await firestoreDeleteResource(resourceId);
        return {
          ...response,
          data
        };
      }
      if (method === "post" && /\/accounts\/[^/?#]+\/set-balance\/?$/.test(endpoint)) {
        const payload = typeof response.config?.data === "string" ? JSON.parse(response.config.data) : (response.config?.data ?? {});
        const accountId = extractAccountIdFromSetBalanceEndpoint(endpoint);
        if (!accountId) throw new Error("Account id introuvable");
        const data = await firestoreSetAccountBalance(accountId, payload);
        return {
          ...response,
          data
        };
      }
    }
    const method = String(response.config.method ?? "").toLowerCase();
    if (["post", "put", "patch", "delete"].includes(method)) {
      void publishSyncEvent(method);
    }
    return response;
  },
  async (error) => {
    const config = error?.config ?? {};
    const method = String(config.method ?? "").toLowerCase();
    const endpoint = normalizeEndpoint(String(config.url ?? ""));
    if (method === "get") {
      try {
        const data = await firestoreGet(endpoint);
        return {
          data,
          status: 200,
          statusText: "OK",
          headers: {},
          config
        };
      } catch {
        // Fall through to original error when Firebase fallback cannot serve this endpoint.
      }
    }
    if (method === "post" && endpoint === "/months") {
      try {
        const payload = typeof config?.data === "string" ? JSON.parse(config.data) : (config?.data ?? {});
        const data = await firestoreCreateMonth(String(payload.label ?? ""));
        return {
          data,
          status: 201,
          statusText: "Created",
          headers: {},
          config
        };
      } catch {
        // Fall through to original error.
      }
    }
    if (method === "post" && endpoint === "/charges") {
      try {
        const payload = typeof config?.data === "string" ? JSON.parse(config.data) : (config?.data ?? {});
        const data = await firestoreCreateCharge(payload);
        return {
          data,
          status: 201,
          statusText: "Created",
          headers: {},
          config
        };
      } catch {
        // Fall through to original error.
      }
    }
    if (method === "post" && endpoint === "/resources") {
      try {
        const payload = typeof config?.data === "string" ? JSON.parse(config.data) : (config?.data ?? {});
        const data = await firestoreCreateResource(payload);
        return {
          data,
          status: 201,
          statusText: "Created",
          headers: {},
          config
        };
      } catch {
        // Fall through to original error.
      }
    }
    if (method === "post" && /\/charges\/[^/?#]+\/payments\/?$/.test(endpoint)) {
      try {
        const payload = typeof config?.data === "string" ? JSON.parse(config.data) : (config?.data ?? {});
        const chargeId = endpoint.split("/")[2] ?? "";
        if (!chargeId) throw new Error("Charge id introuvable");
        const data = await firestoreAddChargePayment(chargeId, payload);
        return {
          data,
          status: 201,
          statusText: "Created",
          headers: {},
          config
        };
      } catch {
        // Fall through to original error.
      }
    }
    if (method === "put" && /\/charges\/[^/?#]+\/?$/.test(endpoint)) {
      try {
        const payload = typeof config?.data === "string" ? JSON.parse(config.data) : (config?.data ?? {});
        const chargeId = extractEntityId(endpoint, "charges");
        if (!chargeId) throw new Error("Charge id introuvable");
        const data = await firestoreUpdateCharge(chargeId, payload);
        return {
          data,
          status: 200,
          statusText: "OK",
          headers: {},
          config
        };
      } catch {
        // Fall through to original error.
      }
    }
    if (method === "put" && /\/resources\/[^/?#]+\/?$/.test(endpoint)) {
      try {
        const payload = typeof config?.data === "string" ? JSON.parse(config.data) : (config?.data ?? {});
        const resourceId = extractEntityId(endpoint, "resources");
        if (!resourceId) throw new Error("Resource id introuvable");
        const data = await firestoreUpdateResource(resourceId, payload);
        return {
          data,
          status: 200,
          statusText: "OK",
          headers: {},
          config
        };
      } catch {
        // Fall through to original error.
      }
    }
    if (method === "patch" && /\/resources\/[^/]+\/status\/?$/.test(endpoint)) {
      try {
        const payload = typeof config?.data === "string" ? JSON.parse(config.data) : (config?.data ?? {});
        const m = /^\/resources\/([^/]+)\/status\/?$/.exec(endpoint);
        const resourceId = m?.[1] ?? "";
        if (!resourceId) throw new Error("Resource id introuvable");
        const data = await firestorePatchResourceStatus(resourceId, payload);
        return {
          data,
          status: 200,
          statusText: "OK",
          headers: {},
          config
        };
      } catch {
        // Fall through to original error.
      }
    }
    if (method === "delete" && /\/charges\/[^/?#]+\/?$/.test(endpoint)) {
      try {
        const chargeId = extractEntityId(endpoint, "charges");
        if (!chargeId) throw new Error("Charge id introuvable");
        const data = await firestoreDeleteCharge(chargeId);
        return {
          data,
          status: 200,
          statusText: "OK",
          headers: {},
          config
        };
      } catch {
        // Fall through to original error.
      }
    }
    if (method === "delete" && /\/resources\/[^/?#]+\/?$/.test(endpoint)) {
      try {
        const resourceId = extractEntityId(endpoint, "resources");
        if (!resourceId) throw new Error("Resource id introuvable");
        const data = await firestoreDeleteResource(resourceId);
        return {
          data,
          status: 200,
          statusText: "OK",
          headers: {},
          config
        };
      } catch {
        // Fall through to original error.
      }
    }
    if (method === "post" && /\/accounts\/[^/?#]+\/set-balance\/?$/.test(endpoint)) {
      try {
        const payload = typeof config?.data === "string" ? JSON.parse(config.data) : (config?.data ?? {});
        const accountId = extractAccountIdFromSetBalanceEndpoint(endpoint);
        if (!accountId) throw new Error("Account id introuvable");
        const data = await firestoreSetAccountBalance(accountId, payload);
        return {
          data,
          status: 200,
          statusText: "OK",
          headers: {},
          config
        };
      } catch {
        // Fall through to original error.
      }
    }
    return Promise.reject(error);
  }
);

/** Même forme YYYY-MM que l'API (évite 2026-6 vs 2026-06). */
function normalizeMonthLabelKey(label: string) {
  const m = /^(\d{4})-(\d{1,2})$/.exec(label.trim());
  if (!m) return label.trim();
  return `${m[1]}-${String(Number(m[2])).padStart(2, "0")}`;
}

function normalizeTextForCompare(value: string) {
  return String(value ?? "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

/** Ligne budget au statut « prévue » (ressource ou charge), aligné SQL `status = 'prevue'`. */
function isPrevueRowStatus(status: unknown) {
  return normalizeTextForCompare(String(status ?? "prevue")) === "PREVUE";
}

/** Charge « à venir » : prévue et reste dû > 0 (aligné `sumChargesAVenirCents` côté API). */
function isChargeAVenirForDashboard(row: any) {
  if (!isPrevueRowStatus(row.status)) return false;
  const paid = Math.round(Number(row.paid_cents ?? 0));
  const total = Math.round(Number(row.amount_cents ?? row.amountCents ?? 0));
  return paid < total;
}

function chargeRemainingDueCents(row: any) {
  const total = Math.round(Number(row.amount_cents ?? row.amountCents ?? 0));
  const paid = Math.round(Number(row.paid_cents ?? 0));
  return Math.max(0, total - paid);
}

/** Toujours : solde à jour (hors épargne côté données) + ressources à venir du mois − charges à venir du même mois. */
function computeSoldeFinMoisPrevuFromKpis(soldeActuel: number, ressourcesAVenir: number, chargesAVenir: number) {
  return Math.round(soldeActuel + ressourcesAVenir - chargesAVenir);
}

type RecurrenceFrequency = "monthly" | "bimonthly" | "yearly";

function monthDiff(fromLabel: string, toLabel: string) {
  const a = /^(\d{4})-(\d{2})$/.exec(normalizeMonthLabelKey(fromLabel));
  const b = /^(\d{4})-(\d{2})$/.exec(normalizeMonthLabelKey(toLabel));
  if (!a || !b) return 0;
  const ay = Number(a[1]);
  const am = Number(a[2]);
  const by = Number(b[1]);
  const bm = Number(b[2]);
  return (by - ay) * 12 + (bm - am);
}

function remapDateToTargetMonth(baseDateYmd: string, targetLabel: string) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(baseDateYmd ?? ""));
  const m = /^(\d{4})-(\d{2})$/.exec(normalizeMonthLabelKey(targetLabel));
  if (!d || !m) return baseDateYmd;
  return `${m[1]}-${m[2]}-${d[3]}`;
}

function daysInCalendarMonth(year: number, month1to12: number) {
  return new Date(year, month1to12, 0).getDate();
}

/** Comme remapDateToTargetMonth mais borne le jour au dernier jour du mois cible (ex. 31 → fevrier). */
function remapYmdSafeToMonthLabel(sourceYmd: string, targetMonthLabel: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(sourceYmd ?? "").trim());
  const m = /^(\d{4})-(\d{2})$/.exec(normalizeMonthLabelKey(targetMonthLabel));
  if (!d || !m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  let day = Number(d[3]);
  const maxDay = daysInCalendarMonth(y, mo);
  if (day > maxDay) day = maxDay;
  return `${m[1]}-${m[2]}-${String(day).padStart(2, "0")}`;
}

function sortMonthsChronoAsc(list: any[]) {
  return [...list].sort((a: any, b: any) => String(a.starts_at ?? a.label ?? "").localeCompare(String(b.starts_at ?? b.label ?? "")));
}

function closeOnBackdropOnly(e: { target: EventTarget | null; currentTarget: EventTarget | null }, close: () => void) {
  if (e.target !== e.currentTarget) return;
  close();
}

function stopModalPropagation(e: { stopPropagation: () => void }) {
  e.stopPropagation();
}

function shouldGenerateRecurring(baseDateYmd: string, targetLabel: string, frequency: RecurrenceFrequency) {
  const m = /^(\d{4})-(\d{2})/.exec(String(baseDateYmd ?? ""));
  if (!m) return false;
  const baseLabel = `${m[1]}-${m[2]}`;
  const diff = monthDiff(baseLabel, targetLabel);
  if (diff < 0) return false;
  if (frequency === "monthly") return true;
  if (frequency === "bimonthly") return diff % 2 === 0;
  return diff % 12 === 0;
}

function useMonth() {
  const [monthId, setMonthId] = useState<string>(() => localStorage.getItem("activeMonthId") ?? "");
  const [months, setMonths] = useState<any[]>([]);
  const refreshMonths = useCallback(async (preferredMonthId?: string) => {
    try {
      const r = await api.get("/months");
      const sorted = [...r.data].sort((a, b) => String(b.starts_at).localeCompare(String(a.starts_at)));
      const uniqueByLabel = new Map<string, any>();
      for (const m of sorted) {
        const lk = normalizeMonthLabelKey(m.label);
        const cur = uniqueByLabel.get(lk);
        if (!cur || String(m.starts_at).localeCompare(String(cur.starts_at)) > 0) {
          uniqueByLabel.set(lk, m);
        }
      }
      const uniqueMonths = Array.from(uniqueByLabel.values()).sort((a, b) => String(b.starts_at).localeCompare(String(a.starts_at)));
      setMonths(uniqueMonths);
      const targetId = preferredMonthId ?? monthId;
      const hasTarget = targetId ? uniqueMonths.some((m) => m.id === targetId) : false;
      if (preferredMonthId && hasTarget) {
        setMonthId(preferredMonthId);
      } else if ((!targetId || !hasTarget) && uniqueMonths[0]) {
        setMonthId(uniqueMonths[0].id);
      }
      return uniqueMonths;
    } catch {
      try {
        const data = await firestoreGet("/months");
        const sorted = [...(Array.isArray(data) ? data : [])].sort((a: any, b: any) => String(b.starts_at).localeCompare(String(a.starts_at)));
        const uniqueByLabel = new Map<string, any>();
        for (const m of sorted) {
          const lk = normalizeMonthLabelKey(m.label);
          const cur = uniqueByLabel.get(lk);
          if (!cur || String(m.starts_at).localeCompare(String(cur.starts_at)) > 0) {
            uniqueByLabel.set(lk, m);
          }
        }
        const uniqueMonths = Array.from(uniqueByLabel.values()).sort((a: any, b: any) => String(b.starts_at).localeCompare(String(a.starts_at)));
        setMonths(uniqueMonths);
        const targetId = preferredMonthId ?? monthId;
        const hasTarget = targetId ? uniqueMonths.some((m: any) => m.id === targetId) : false;
        if (preferredMonthId && hasTarget) {
          setMonthId(preferredMonthId);
        } else if ((!targetId || !hasTarget) && uniqueMonths[0]) {
          setMonthId(uniqueMonths[0].id);
        }
        return uniqueMonths;
      } catch {
        setMonths([]);
        return [];
      }
    }
  }, [monthId]);
  useEffect(() => {
    void refreshMonths();
  }, [refreshMonths]);
  useEffect(() => {
    if (monthId) localStorage.setItem("activeMonthId", monthId);
  }, [monthId]);
  return { monthId, setMonthId, months, refreshMonths };
}

function toMoney(cents: number) {
  return `${(cents / 100).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })} DHS`;
}

function balanceSignClass(cents: number) {
  return cents < 0 ? "balance-link-negative" : "balance-link-positive";
}

function chargeCategoryIcon(category: string) {
  const c = String(category ?? "").toLowerCase();
  if (c.includes("course") || c.includes("aliment")) return ShoppingBasket;
  if (c.includes("telephone") || c.includes("phone") || c.includes("mobile")) return Smartphone;
  if (c.includes("internet") || c.includes("wifi")) return Wifi;
  if (c.includes("essence") || c.includes("carbur") || c.includes("voiture")) return Car;
  if (c.includes("logement") || c.includes("loyer") || c.includes("maison")) return Home;
  if (c.includes("loisir") || c.includes("game")) return Gamepad2;
  if (c.includes("sante") || c.includes("santé") || c.includes("medical")) return HeartPulse;
  return ReceiptText;
}

function formatMonthLabel(label: string) {
  const key = normalizeMonthLabelKey(label);
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return label;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  return date.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}

function formatDateDMY(value: string | null | undefined) {
  const s = String(value ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return s;
}

function parseDateDMY(value: string | null | undefined) {
  const s = String(value ?? "").trim();
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || yyyy < 1900) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function getMonthLabelKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseMonthLabel(label: string) {
  const key = normalizeMonthLabelKey(label);
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(m[1]), month };
}

function Toast({ message }: { message: string }) {
  if (!message) return null;
  return <div className="toast">{message}</div>;
}

const LS_CHARGE_LABELS = "budget_charge_labels";
const LS_CHARGE_CATEGORIES = "budget_charge_categories";

function readChargeSuggestions(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function pushChargeSuggestion(key: string, value: string) {
  const v = value.trim();
  if (!v) return;
  const arr = readChargeSuggestions(key);
  const lower = v.toLowerCase();
  if (arr.some((x) => String(x).toLowerCase() === lower)) return;
  arr.push(v);
  localStorage.setItem(key, JSON.stringify(arr.slice(-150)));
}

function Dashboard({ monthId, dataRevision }: { monthId: string; dataRevision: number }) {
  const [data, setData] = useState<any>(null);
  const [loadError, setLoadError] = useState("");
  const [historyTitle, setHistoryTitle] = useState("");
  const [historyRows, setHistoryRows] = useState<any[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  useEffect(() => {
    if (!monthId) {
      setData({
        soldeActuel: 0,
        soldeFinMoisPrevu: 0,
        epargne: 0,
        chargesAVenir: 0,
        ressourcesAVenir: 0
      });
      setLoadError("");
      return;
    }
    setLoadError("");
    api
      .get(`/dashboard/${monthId}`, { params: import.meta.env.DEV ? { debug: "1" } : {} })
      .then((r) => {
        setData(r.data);
        if (r.data?._debug && typeof console !== "undefined" && console.debug) {
          console.debug("[dashboard] API _debug", r.data._debug);
        }
      })
      .catch((err) => {
        setData(null);
        setLoadError(err?.response?.data?.message ?? err?.message ?? "Impossible de charger le tableau de bord.");
      });
  }, [monthId, dataRevision]);
  if (loadError) {
    return (
      <div className="card stack">
        <p>{loadError}</p>
        <p className="muted">Verifiez que l&apos;API tourne et que le mois existe. Ouvrez la console navigateur (F12) pour le detail _debug.</p>
      </div>
    );
  }
  if (!data) return <div>Chargement...</div>;
  const soldeActuel = Math.round(Number(data.soldeActuel ?? 0));
  const epargne = Math.round(Number(data.epargne ?? 0));
  const ressourcesAVenir = Math.round(Number(data.ressourcesAVenir ?? 0));
  const chargesAVenir = Math.round(Number(data.chargesAVenir ?? 0));
  const soldeFinMoisPrevu = computeSoldeFinMoisPrevuFromKpis(soldeActuel, ressourcesAVenir, chargesAVenir);
  const cards = [
    { label: "Solde a jour", value: soldeActuel, icon: "💼", cls: "c1" },
    { label: "Solde prevu fin de mois", value: soldeFinMoisPrevu, icon: "📅", cls: "c2" },
    { label: "Epargne", value: epargne, icon: "🛡️", cls: "c4" },
    { label: "Charges a venir", value: chargesAVenir, icon: "📉", cls: "c5" },
    { label: "Ressources a venir", value: ressourcesAVenir, icon: "📈", cls: "c6" }
  ];
  const onCardClick = async (label: string) => {
    setHistoryTitle(`Historique - ${label}`);
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      if (label === "Ressources a venir") {
        const res = await api.get(`/resources/${monthId}`);
        setHistoryRows(res.data.filter((r: any) => r.status === "prevue").map((r: any) => ({
          date: r.expected_date,
          type: "ressource_prevue",
          note: r.type,
          amount_cents: r.amount_cents
        })));
      } else if (label === "Charges a venir") {
        const res = await api.get(`/charges/${monthId}`);
        setHistoryRows(res.data.filter((c: any) => c.status === "prevue" && Number(c.paid_cents) < Number(c.amount_cents)).map((c: any) => ({
          date: c.expected_date,
          type: "charge_prevue",
          note: c.label,
          amount_cents: c.amount_cents - c.paid_cents
        })));
      } else {
        const res = await api.get(`/accounts-history/${monthId}`);
        const base = res.data;
        if (label === "Epargne") {
          setHistoryRows(base.filter((h: any) => String(h.account_name).toUpperCase() === "EPARGNE"));
        } else if (label === "Solde a jour" || label === "Solde prevu fin de mois") {
          setHistoryRows(base.filter((h: any) => String(h.account_name).toUpperCase() !== "EPARGNE"));
        } else {
          setHistoryRows(base);
        }
      }
    } finally {
      setHistoryLoading(false);
    }
  };
  return (
    <>
      <div className="grid dashboard-metrics">{cards.map((c) => <MetricCard key={c.label} {...c} onClick={() => onCardClick(c.label)} />)}</div>
      {historyOpen && (
        <div className="modal-backdrop" onClick={(e) => closeOnBackdropOnly(e, () => setHistoryOpen(false))}>
          <div className="modal card stack" onClick={stopModalPropagation} onMouseDown={stopModalPropagation} onPointerDown={stopModalPropagation}>
            <h3>{historyTitle}</h3>
            {historyLoading && <div>Chargement...</div>}
            {!historyLoading && historyRows.length === 0 && <div className="muted">Aucune donnee pour ce solde.</div>}
            {!historyLoading && historyRows.map((h, i) => (
              <div className="row card" key={`${h.type}-${h.id ?? i}`}>
                <div>
                  <strong>{h.type ?? "-"}</strong>
                  <div className="muted">{formatDateDMY(String(h.date ?? ""))} · {h.note || "-"}</div>
                </div>
                <strong>{toMoney(Number(h.amount_cents ?? 0))}</strong>
              </div>
            ))}
            <button className="secondary" onClick={() => setHistoryOpen(false)}>Fermer</button>
          </div>
        </div>
      )}
    </>
  );
}

function MetricCard({ label, value, icon, cls, onClick }: { label: string; value: number; icon: string; cls: string; onClick?: () => void }) {
  return (
    <button className={`card metric metric-btn ${cls}`} title="Cliquer pour voir le detail" onClick={onClick}>
      <div className="metric-top">
        <span className="metric-icon">{icon}</span>
        <span className="metric-label">{label}</span>
      </div>
      <div className="metric-value">{toMoney(value)}</div>
    </button>
  );
}

function accountVisual(name: string) {
  const key = name.toUpperCase();
  if (key.includes("BANK OF AFRICA")) return { icon: "🏦", cls: "av1" };
  if (key.includes("SAHAM")) return { icon: "💳", cls: "av2" };
  if (key.includes("MELANIE")) return { icon: "👩", cls: "av3" };
  if (key.includes("SAAD 1")) return { icon: "👨", cls: "av4" };
  if (key.includes("SAAD 2")) return { icon: "🧾", cls: "av5" };
  if (key.includes("ESPECE")) return { icon: "💵", cls: "av6" };
  if (key.includes("EPARGNE")) return { icon: "🛡️", cls: "av7" };
  return { icon: "💼", cls: "av1" };
}

function Accounts({ monthId, months, dataRevision, notify }: { monthId: string; months: any[]; dataRevision: number; notify: (msg: string) => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [historyWithBalance, setHistoryWithBalance] = useState<any[]>([]);
  const [openingHistoryAccountId, setOpeningHistoryAccountId] = useState("");
  const [historyAccount, setHistoryAccount] = useState<any | null>(null);
  const [resourceAccount, setResourceAccount] = useState<any | null>(null);
  const [transferAccount, setTransferAccount] = useState<any | null>(null);
  const [balanceAccount, setBalanceAccount] = useState<any | null>(null);
  const [resourceForm, setResourceForm] = useState({
    type: "Autres",
    amount: "",
    expectedDate: formatDateDMY(todayYmd()),
    status: "prevue" as "prevue" | "recue",
    note: ""
  });
  const [transferForm, setTransferForm] = useState({
    to: "",
    amount: "",
    date: todayYmd(),
    note: ""
  });
  const [balanceForm, setBalanceForm] = useState({ amount: "", note: "" });
  const [resourceTargetMonthId, setResourceTargetMonthId] = useState("");
  const [resourceDuplicateAllMonths, setResourceDuplicateAllMonths] = useState(false);
  const sortedMonthsAsc = useMemo(() => sortMonthsChronoAsc(months), [months]);

  useEffect(() => {
    setResourceTargetMonthId(monthId);
  }, [monthId]);

  const refreshAccounts = async () => {
    if (!monthId && FIREBASE_ONLY) {
      const data = await firestoreGet("/accounts/global");
      setRows(Array.isArray(data) ? data : []);
      return;
    }
    if (!monthId) {
      setRows([]);
      return;
    }
    const res = await api.get(`/accounts/${monthId}`);
    setRows(res.data);
  };

  const loadHistory = async (accountId: string) => {
    const historyRes = await api.get(`/accounts-history/${monthId}`, { params: { accountId } });
    const account = rows.find((r) => r.id === accountId);
    let cursor = Number(account?.balance_cents ?? 0);
    const enriched = (historyRes.data as any[]).map((h) => {
      const delta = Number(h.delta_cents ?? 0);
      const after = cursor;
      const before = after - delta;
      cursor = before;
      return { ...h, delta_cents: delta, balance_after_cents: after, balance_before_cents: before };
    });
    setHistory(historyRes.data);
    setHistoryWithBalance(enriched);
  };

  const openHistory = async (account: any) => {
    if (openingHistoryAccountId === account.id) return;
    setOpeningHistoryAccountId(account.id);
    setHistoryAccount(account);
    try {
      await loadHistory(account.id);
    } finally {
      setOpeningHistoryAccountId("");
    }
  };

  useEffect(() => {
    refreshAccounts();
  }, [monthId, dataRevision]);

  const submitResource = async (e: FormEvent) => {
    e.preventDefault();
    if (!resourceAccount) return;
    const expectedDateYmd = parseDateDMY(resourceForm.expectedDate);
    if (!expectedDateYmd) {
      notify("Date invalide. Utilisez le format JJ/MM/AAAA");
      return;
    }
    const targetList = resourceDuplicateAllMonths ? sortedMonthsAsc : sortedMonthsAsc.filter((m: any) => m.id === resourceTargetMonthId);
    if (targetList.length === 0) {
      notify("Aucun mois selectionne");
      return;
    }
    try {
      for (const m of targetList) {
        const ymd = remapYmdSafeToMonthLabel(expectedDateYmd, String(m.label ?? ""));
        if (!ymd) {
          notify("Mois invalide dans la liste");
          return;
        }
        await api.post("/resources", {
          monthId: m.id,
          type: resourceForm.type,
          amountCents: Math.round(Number(resourceForm.amount) * 100),
          accountId: resourceAccount.id,
          expectedDate: ymd,
          status: resourceForm.status,
          note: resourceForm.note
        });
      }
      notify(targetList.length > 1 ? `Ressource ajoutee sur ${targetList.length} mois` : "Ressource ajoutee avec succes");
    } catch (err: any) {
      notify(String(err?.response?.data?.message ?? err?.message ?? "Echec creation ressource"));
      return;
    }
    setResourceAccount(null);
    setResourceDuplicateAllMonths(false);
    setResourceForm((prev) => ({ ...prev, amount: "", expectedDate: formatDateDMY(todayYmd()), note: "", status: "prevue" }));
    await refreshAccounts();
  };

  const submitTransfer = async (e: FormEvent) => {
    e.preventDefault();
    if (!transferAccount) return;
    await api.post("/transfers", {
      monthId,
      fromAccountId: transferAccount.id,
      toAccountId: transferForm.to,
      amountCents: Math.round(Number(transferForm.amount) * 100),
      transferDate: transferForm.date || new Date().toISOString(),
      note: transferForm.note
    });
    notify("Transfert effectue avec succes");
    setTransferAccount(null);
    setTransferForm({ to: "", amount: "", date: todayYmd(), note: "" });
    await refreshAccounts();
  };

  const submitBalance = async (e: FormEvent) => {
    e.preventDefault();
    if (!balanceAccount) return;
    const nextBalanceCents = Math.round(Number(balanceForm.amount) * 100);
    const currentBalanceCents = Number(balanceAccount.balance_cents ?? 0);
    const hasGap = nextBalanceCents !== currentBalanceCents;
    if (hasGap && !balanceForm.note.trim()) {
      notify("Justification obligatoire en cas d'ecart de solde");
      return;
    }
    try {
      await api.post(`/accounts/${balanceAccount.id}/set-balance`, {
        newBalanceCents: nextBalanceCents,
        note: balanceForm.note || "Modification manuelle"
      });
    } catch (err: any) {
      notify(String(err?.message ?? "Impossible d'enregistrer le solde."));
      return;
    }
    notify("Solde du compte mis a jour");
    setBalanceAccount(null);
    setBalanceForm({ amount: "", note: "" });
    await refreshAccounts();
  };

  const deleteHistory = async (item: any) => {
    if (!window.confirm("Voulez-vous vraiment supprimer cette operation ?")) return;
    if (item.source === "transfer") {
      await api.delete(`/transfers/${item.id}`);
      notify("Transfert supprime");
    } else if (item.source === "adjustment") {
      await api.delete(`/account-adjustments/${item.id}`);
      notify("Modification manuelle supprimee");
    } else {
      notify("Suppression non disponible pour ce type");
      return;
    }
    if (historyAccount) await loadHistory(historyAccount.id);
    await refreshAccounts();
  };

  return (
    <div className="stack">
      <div className="accounts-grid">
        {rows.map((a) => {
          const v = accountVisual(a.name);
          return (
            <div className={`card account-card ${v.cls}`} key={a.id}>
              <div className="row">
                <div className="row" style={{ gap: 8 }}>
                  <span className="account-icon">{v.icon}</span>
                  <strong>{a.name}</strong>
                </div>
                <button
                  type="button"
                  className="balance-hitbox"
                  title="Voir l'historique de ce solde"
                  disabled={openingHistoryAccountId === a.id}
                  onClick={() => openHistory(a)}
                >
                  <span className={`balance-link ${balanceSignClass(Number(a.balance_cents ?? 0))}`}>
                    {openingHistoryAccountId === a.id ? "Ouverture..." : toMoney(a.balance_cents)}
                  </span>
                </button>
              </div>
              <div className="account-actions">
                {String(a.name).toUpperCase() !== "EPARGNE" && (
                  <button className="mini success" onClick={() => setResourceAccount(a)}>Ajouter ressource</button>
                )}
                <button className="mini info" onClick={() => setTransferAccount(a)}>Transferer</button>
                <button className="mini secondary" onClick={() => setBalanceAccount(a)}>Modifier solde</button>
              </div>
            </div>
          );
        })}
      </div>

      {historyAccount && (
        <div className="modal-backdrop" onClick={(e) => closeOnBackdropOnly(e, () => setHistoryAccount(null))}>
          <div className="modal card stack" onClick={stopModalPropagation} onMouseDown={stopModalPropagation} onPointerDown={stopModalPropagation}>
            <h3>Historique - {historyAccount.name}</h3>
            {historyWithBalance.length === 0 && <div className="muted">Aucune operation sur ce compte.</div>}
            {historyWithBalance.map((h) => (
              <div className="row card" key={`${h.source}-${h.id}`}>
                <div>
                  <strong>{h.account_name}</strong>
                  <div className="muted">{formatDateDMY(String(h.date))} · {h.type} · {h.note || "-"}</div>
                  <div className="muted">
                    Mouvement: {toMoney(Number(h.delta_cents ?? 0))} · Solde apres: {toMoney(Number(h.balance_after_cents ?? 0))}
                  </div>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <span>{toMoney(Number(h.amount_cents ?? 0))}</span>
                  {(h.source === "transfer" || h.source === "adjustment") && (
                    <button className="danger" onClick={() => deleteHistory(h)}>Supprimer</button>
                  )}
                </div>
              </div>
            ))}
            <button className="secondary" onClick={() => setHistoryAccount(null)}>Fermer</button>
          </div>
        </div>
      )}

      {resourceAccount && (
        <div className="modal-backdrop" onClick={(e) => closeOnBackdropOnly(e, () => setResourceAccount(null))}>
          <form className="modal card stack" onClick={stopModalPropagation} onMouseDown={stopModalPropagation} onPointerDown={stopModalPropagation} onSubmit={submitResource}>
            <h3>Ajouter une ressource - {resourceAccount.name}</h3>
            <label className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span className="muted">Mois budget</span>
              <select
                value={resourceTargetMonthId}
                disabled={resourceDuplicateAllMonths}
                onChange={(e) => setResourceTargetMonthId(e.target.value)}
                required
              >
                {sortedMonthsAsc.map((m: any) => (
                  <option key={m.id} value={m.id}>
                    {formatMonthLabel(String(m.label ?? "")).toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className="row" style={{ gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={resourceDuplicateAllMonths}
                onChange={(e) => setResourceDuplicateAllMonths(e.target.checked)}
              />
              <span>Créer sur tous les mois (date ajustee par mois)</span>
            </label>
            <select value={resourceForm.type} onChange={(e) => setResourceForm({ ...resourceForm, type: e.target.value })}>
              {RESOURCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input type="number" min="0.01" step="0.01" placeholder="Montant" value={resourceForm.amount} onChange={(e) => setResourceForm({ ...resourceForm, amount: e.target.value })} required />
            <input
              type="text"
              inputMode="numeric"
              placeholder="JJ/MM/AAAA"
              value={resourceForm.expectedDate}
              onChange={(e) => setResourceForm({ ...resourceForm, expectedDate: e.target.value })}
              required
            />
            <select value={resourceForm.status} onChange={(e) => setResourceForm({ ...resourceForm, status: e.target.value as "prevue" | "recue" })}>
              <option value="prevue">Prevue</option>
              <option value="recue">Recue</option>
            </select>
            <input placeholder="Note (facultative)" value={resourceForm.note} onChange={(e) => setResourceForm({ ...resourceForm, note: e.target.value })} />
            <div className="row">
              <button>Ajouter la ressource</button>
              <button type="button" className="secondary" onClick={() => setResourceAccount(null)}>Annuler</button>
            </div>
          </form>
        </div>
      )}

      {transferAccount && (
        <div className="modal-backdrop" onClick={(e) => closeOnBackdropOnly(e, () => setTransferAccount(null))}>
          <form className="modal card stack" onClick={stopModalPropagation} onMouseDown={stopModalPropagation} onPointerDown={stopModalPropagation} onSubmit={submitTransfer}>
            <h3>Transferer depuis {transferAccount.name}</h3>
            <div className="muted">
              Solde actuel: <strong>{toMoney(Number(transferAccount.balance_cents ?? 0))}</strong>
            </div>
            <select value={transferForm.to} onChange={(e) => setTransferForm({ ...transferForm, to: e.target.value })} required>
              <option value="">Compte destination</option>
              {rows.filter((r) => r.id !== transferAccount.id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <input type="number" min="0.01" step="0.01" placeholder="Montant" value={transferForm.amount} onChange={(e) => setTransferForm({ ...transferForm, amount: e.target.value })} required />
            <div className="muted">
              Solde apres transfert:{" "}
              <strong>
                {toMoney(Number(transferAccount.balance_cents ?? 0) - Math.round((Number(transferForm.amount) || 0) * 100))}
              </strong>
            </div>
            <input type="date" value={transferForm.date} onChange={(e) => setTransferForm({ ...transferForm, date: e.target.value })} required />
            <input placeholder="Note (facultative)" value={transferForm.note} onChange={(e) => setTransferForm({ ...transferForm, note: e.target.value })} />
            <div className="row">
              <button>Valider transfert</button>
              <button type="button" className="secondary" onClick={() => setTransferAccount(null)}>Annuler</button>
            </div>
          </form>
        </div>
      )}

      {balanceAccount && (
        <div className="modal-backdrop" onClick={(e) => closeOnBackdropOnly(e, () => setBalanceAccount(null))}>
          <form className="modal card stack" onClick={stopModalPropagation} onMouseDown={stopModalPropagation} onPointerDown={stopModalPropagation} onSubmit={submitBalance}>
            <h3>Modifier solde - {balanceAccount.name}</h3>
            <div className="muted">
              Solde actuel:{" "}
              <strong>{toMoney(Number(balanceAccount.balance_cents ?? 0))}</strong>
            </div>
            <input type="number" placeholder="Nouveau solde (DHS)" value={balanceForm.amount} onChange={(e) => setBalanceForm({ ...balanceForm, amount: e.target.value })} required />
            <div className="muted">
              Nouveau solde:{" "}
              <strong>{toMoney(Math.round((Number(balanceForm.amount) || 0) * 100))}</strong>
            </div>
            <input placeholder="Justification (obligatoire si ecart)" value={balanceForm.note} onChange={(e) => setBalanceForm({ ...balanceForm, note: e.target.value })} />
            <div className="row">
              <button>Enregistrer</button>
              <button type="button" className="secondary" onClick={() => setBalanceAccount(null)}>Annuler</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function Resources({ monthId, dataRevision, accounts, notify }: { monthId: string; dataRevision: number; accounts: any[]; notify: (msg: string) => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [historyResource, setHistoryResource] = useState<any | null>(null);
  const [resourceHistoryRows, setResourceHistoryRows] = useState<any[]>([]);
  const [filterAccountId, setFilterAccountId] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  useEffect(() => {
    if (!monthId) {
      setRows([]);
      return;
    }
    api.get(`/resources/${monthId}`).then((r) => setRows(r.data));
  }, [monthId, dataRevision]);

  const setReceived = async (id: string, status: "prevue" | "recue") => {
    await api.patch(`/resources/${id}/status`, { status });
    notify(status === "recue" ? "Ressource marquee recue et solde mis a jour" : "Ressource remise en prevue");
    const res = await api.get(`/resources/${monthId}`);
    setRows(res.data);
  };
  const remove = async (id: string) => {
    if (!window.confirm("Voulez-vous vraiment supprimer cette ressource ?")) return;
    const rid = String(id ?? "").trim();
    if (!rid) return;
    try {
      if (FIREBASE_ONLY) {
        await firestoreDeleteResource(rid);
        void publishSyncEvent("delete-resource");
      } else {
        await api.delete(`/resources/${rid}`);
      }
      notify("Ressource supprimee avec succes");
      setRows((prev) => prev.filter((r) => String(r.id) !== rid));
    } catch (err: any) {
      notify(String(err?.response?.data?.message ?? err?.message ?? "Impossible de supprimer la ressource"));
    }
  };
  const openHistoryModal = async (resource: any) => {
    const res = await api.get(`/resources/${resource.id}/annual-history`);
    setResourceHistoryRows(res.data);
    setHistoryResource(resource);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const expectedDateYmd = parseDateDMY(editing.expected_date_input ?? formatDateDMY(editing.expected_date));
    if (!expectedDateYmd) {
      notify("Date invalide. Utilisez le format JJ/MM/AAAA");
      return;
    }
    const payload = {
      type: editing.type,
      amountCents: Math.round(Number(editing.amount_cents)),
      accountId: editing.account_id,
      expectedDate: expectedDateYmd,
      isRecurrent: Boolean(editing.is_recurrent),
      recurrenceFrequency: String(editing.recurrence_frequency ?? "monthly")
    };
    const applyToFuture = Boolean(editing.is_recurrent) && window.confirm("Modifier tous les mois suivants ?\nOK = tous les mois suivants\nAnnuler = uniquement ce mois");
    await api.put(`/resources/${editing.id}`, payload);
    if (FIREBASE_ONLY && payload.isRecurrent && applyToFuture) {
      await firestoreApplyRecurringRuleToFuture("resources", String(editing.recurrence_root ?? editing.id), monthId, {
        type: payload.type,
        amount_cents: payload.amountCents,
        account_id: payload.accountId,
        expected_date: payload.expectedDate,
        is_recurrent: true,
        recurrence_frequency: payload.recurrenceFrequency,
        recurrence_root: String(editing.recurrence_root ?? editing.id)
      });
    }
    notify("Ressource modifiee avec succes");
    setEditing(null);
    const res = await api.get(`/resources/${monthId}`);
    setRows(res.data);
  };

  const accountNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts) m.set(a.id, a.name);
    return m;
  }, [accounts]);

  const historyRows = useMemo(() => {
    const sorted = [...rows].sort((a, b) => String(b.expected_date).localeCompare(String(a.expected_date)));
    return sorted.filter((r) => {
      if (filterAccountId && r.account_id !== filterAccountId) return false;
      if (filterType && r.type !== filterType) return false;
      if (filterStatus && r.status !== filterStatus) return false;
      return true;
    });
  }, [rows, filterAccountId, filterType, filterStatus]);

  return (
    <div className="stack">
      <div className="accounts-grid">
        {historyRows.map((r) => {
          const Icon = chargeCategoryIcon(r.type);
          const statusText = r.status === "recue" ? "Recue" : "Prevue";
          return (
            <div className="card stack charge-card premium-charge" key={r.id}>
              <div className="row charge-head">
                <div className="row charge-title-wrap">
                  <span className="charge-icon-badge"><Icon size={18} /></span>
                  <div className="stack" style={{ gap: 2 }}>
                    <strong className="charge-title" title={String(r.type ?? "")}>{r.type}</strong>
                    <span className="muted charge-category">{accountNameById.get(r.account_id) ?? "-"}</span>
                    {Boolean(r.is_recurrent) ? <span className="muted">Recurrent</span> : null}
                    {r.note ? <span className="muted charge-category">{r.note}</span> : null}
                  </div>
                </div>
                <div className="stack align-end charge-values">
                  <span className="muted charge-kpi-label">Montant</span>
                  <strong className="charge-kpi-main">{toMoney(Number(r.amount_cents ?? 0))}</strong>
                </div>
              </div>
              <div className="charge-stats-grid">
                <div className="charge-stat">
                  <span className="muted charge-kpi-label">Date</span>
                  <strong>{formatDateDMY(String(r.expected_date))}</strong>
                </div>
                <div className={`charge-stat charge-stat-remaining ${r.status === "recue" ? "rem-ok" : "rem-normal"}`}>
                  <span className="muted charge-kpi-label">Statut</span>
                  <strong>{statusText}</strong>
                </div>
              </div>
              <div className="stack charge-progress-block" style={{ gap: 6 }}>
                <div className="row charge-progress-placeholder-label">
                  <span className="muted charge-kpi-label">Progression</span>
                  <strong className="charge-progress-pct">--</strong>
                </div>
                <div className="charge-progress-track charge-progress-placeholder-track" />
              </div>
              <div className="row actions charge-actions">
                <button
                  className="btn-action pay"
                  title="Bouton Recue : marquer une ressource comme recue et augmenter le compte"
                  onClick={() => setReceived(r.id, r.status === "recue" ? "prevue" : "recue")}
                >
                  <Wallet size={14} /> {r.status === "recue" ? "Remettre prevue" : "Recue"}
                </button>
                <button className="btn-action history" onClick={() => openHistoryModal(r)}>
                  <ReceiptText size={14} /> Historique
                </button>
                <button
                  className="btn-action edit"
                  title="Bouton Modifier : changer les informations d'une ligne"
                  onClick={() => setEditing({ ...r, expected_date_input: formatDateDMY(r.expected_date) })}
                >
                  <Pencil size={14} /> Modifier
                </button>
                <button className="btn-action delete" title="Bouton Supprimer : supprimer uniquement apres confirmation" onClick={() => remove(r.id)}>
                  <Trash2 size={14} /> Supprimer
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={(e) => closeOnBackdropOnly(e, () => setEditing(null))}>
          <form className="modal card stack" onClick={stopModalPropagation} onMouseDown={stopModalPropagation} onPointerDown={stopModalPropagation} onSubmit={save}>
            <h3>Modifier ressource</h3>
            <select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value })}>
              {RESOURCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input type="number" value={editing.amount_cents} onChange={(e) => setEditing({ ...editing, amount_cents: Number(e.target.value) })} required />
            <select value={editing.account_id} onChange={(e) => setEditing({ ...editing, account_id: e.target.value })}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select value={editing.is_recurrent ? "yes" : "no"} onChange={(e) => setEditing({ ...editing, is_recurrent: e.target.value === "yes" })}>
              <option value="no">Recurrente: Non</option>
              <option value="yes">Recurrente: Oui</option>
            </select>
            {editing.is_recurrent ? (
              <select value={editing.recurrence_frequency ?? "monthly"} onChange={(e) => setEditing({ ...editing, recurrence_frequency: e.target.value })}>
                <option value="monthly">Tous les mois</option>
                <option value="bimonthly">Tous les 2 mois</option>
                <option value="yearly">Tous les ans</option>
              </select>
            ) : null}
            <input
              type="text"
              inputMode="numeric"
              placeholder="JJ/MM/AAAA"
              value={editing.expected_date_input ?? formatDateDMY(editing.expected_date)}
              onChange={(e) => setEditing({ ...editing, expected_date_input: e.target.value })}
              required
            />
            <div className="row">
              <button>Enregistrer</button>
              <button type="button" className="secondary" onClick={() => setEditing(null)}>Annuler</button>
            </div>
          </form>
        </div>
      )}

      {historyResource && (
        <div className="modal-backdrop" onClick={(e) => closeOnBackdropOnly(e, () => setHistoryResource(null))}>
          <div className="modal card stack" onClick={stopModalPropagation} onMouseDown={stopModalPropagation} onPointerDown={stopModalPropagation}>
            <h3>Historique - {historyResource.type}</h3>
            <div className="muted">Ressources sur les 12 derniers mois (minimum) pour ce type.</div>
            {resourceHistoryRows.length === 0 && <div className="muted">Aucune ressource sur cette periode.</div>}
            {resourceHistoryRows.map((h) => (
              <div className="row card" key={h.id}>
                <div className="muted">
                  {formatDateDMY(String(h.expected_date))} · {h.month_label || "-"} · {h.account_name || "-"} · {h.status || "-"}
                  {h.note ? ` · ${h.note}` : ""}
                </div>
                <strong>{toMoney(Number(h.amount_cents ?? 0))}</strong>
              </div>
            ))}
            <button className="secondary" onClick={() => setHistoryResource(null)}>Fermer</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Charges({ monthId, dataRevision, accounts, notify }: { monthId: string; dataRevision: number; accounts: any[]; notify: (msg: string) => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [paymentCharge, setPaymentCharge] = useState<any | null>(null);
  const [historyCharge, setHistoryCharge] = useState<any | null>(null);
  const [paymentForm, setPaymentForm] = useState({
    accountId: "",
    amount: "",
    paymentDate: formatDateDMY(todayYmd()),
    paymentMode: "espece",
    note: ""
  });
  const [paymentHistory, setPaymentHistory] = useState<any[]>([]);
  const [paymentSaving, setPaymentSaving] = useState(false);
  const [paymentError, setPaymentError] = useState("");
  const [chargeHistoryRows, setChargeHistoryRows] = useState<any[]>([]);
  useEffect(() => {
    if (!monthId) {
      setRows([]);
      return;
    }
    api.get(`/charges/${monthId}`).then((r) => setRows(r.data));
  }, [monthId, dataRevision]);

  const sortedRows = useMemo(() => {
    const priority = (row: any) => {
      const total = Number(row.amount_cents ?? 0);
      const paid = Number(row.paid_cents ?? 0);
      const remaining = Math.max(0, total - paid);
      if (remaining <= 0 || paid >= total) return 2; // payee en dernier
      if (paid > 0) return 1; // partielle
      return 0; // a payer
    };
    return [...rows].sort((a, b) => {
      const pa = priority(a);
      const pb = priority(b);
      if (pa !== pb) return pa - pb;
      return String(a.expected_date ?? "").localeCompare(String(b.expected_date ?? ""));
    });
  }, [rows]);

  const accountNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts) m.set(a.id, a.name);
    return m;
  }, [accounts]);

  const openPaymentModal = async (charge: any) => {
    const paid = Number(charge.paid_cents ?? 0);
    const total = Number(charge.amount_cents ?? 0);
    const remainingCents = Math.max(0, total - paid);
    const defaultAmountStr = remainingCents > 0 ? (remainingCents / 100).toFixed(2) : "";
    const isTotale = (charge.charge_type ?? "totale") === "totale";
    const defaultAccountId = charge.account_id || accounts[0]?.id || "";
    setPaymentForm({
      accountId: defaultAccountId,
      amount: isTotale ? defaultAmountStr : "",
      paymentDate: formatDateDMY(todayYmd()),
      paymentMode: "espece",
      note: ""
    });
    setPaymentError("");
    const historyRes = await api.get(`/charges/${charge.id}/payments`);
    setPaymentHistory(historyRes.data);
    setPaymentCharge(charge);
  };

  const openHistoryModal = async (charge: any) => {
    const historyRes = await api.get(`/charges/${charge.id}/annual-history`);
    setChargeHistoryRows(historyRes.data);
    setHistoryCharge(charge);
  };

  const submitPayment = async (e: FormEvent) => {
    e.preventDefault();
    if (!paymentCharge) return;
    setPaymentError("");
    const paymentDateYmd = parseDateDMY(paymentForm.paymentDate);
    if (!paymentDateYmd) {
      notify("Date invalide. Utilisez le format JJ/MM/AAAA");
      return;
    }
    const paidBefore = Number(paymentCharge.paid_cents ?? 0);
    const total = Number(paymentCharge.amount_cents ?? 0);
    const normalizedAmount = String(paymentForm.amount ?? "").replace(",", ".").trim();
    const amountCents = Math.round(Number(normalizedAmount) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      const message = "Montant invalide. Entrez un montant > 0.";
      setPaymentError(message);
      notify(message);
      return;
    }
    if (!paymentForm.accountId) {
      const message = "Choisissez un compte de paiement.";
      setPaymentError(message);
      notify(message);
      return;
    }
    try {
      setPaymentSaving(true);
      if (FIREBASE_ONLY) {
        await firestoreAddChargePayment(String(paymentCharge.id), {
          accountId: paymentForm.accountId,
          amountCents,
          paymentDate: paymentDateYmd,
          paymentMode: paymentForm.paymentMode,
          note: paymentForm.note
        });
      } else {
        await api.post(`/charges/${paymentCharge.id}/payments`, {
          accountId: paymentForm.accountId,
          amountCents,
          paymentDate: paymentDateYmd,
          paymentMode: paymentForm.paymentMode,
          note: paymentForm.note
        });
      }
      const paidAfter = paidBefore + amountCents;
      if (paidAfter >= total) notify("Paiement enregistre — charge entierement reglee");
      else notify("Paiement enregistre — solde et restant mis a jour");
      await publishSyncEvent("payment");
      const [updatedCharges, updatedHistory] = FIREBASE_ONLY
        ? await Promise.all([firestoreGet(`/charges/${monthId}`), firestoreGetChargePayments(String(paymentCharge.id))])
        : await Promise.all([
          api.get(`/charges/${monthId}`).then((r) => r.data),
          api.get(`/charges/${paymentCharge.id}/payments`).then((r) => r.data)
        ]);
      setRows(updatedCharges);
      setPaymentHistory(updatedHistory);
      const updated = updatedCharges.find((c: any) => c.id === paymentCharge.id);
      if (updated) {
        setPaymentCharge(updated);
      }
      notify("Paiement enregistre avec succes");
      setPaymentCharge(null);
    } catch (err: any) {
      const message = String(err?.response?.data?.message ?? err?.message ?? "Echec du paiement");
      setPaymentError(message);
      console.error("[PAIEMENT] Erreur complete", err);
      notify(message);
    } finally {
      setPaymentSaving(false);
    }
  };
  const remove = async (id: string) => {
    if (!window.confirm("Voulez-vous vraiment supprimer cette charge ?")) return;
    const cid = String(id ?? "").trim();
    if (!cid) return;
    try {
      if (FIREBASE_ONLY) {
        await firestoreDeleteCharge(cid);
        void publishSyncEvent("delete-charge");
      } else {
        await api.delete(`/charges/${cid}`);
      }
      notify("Charge supprimee avec succes");
      setRows((prev) => prev.filter((r) => String(r.id) !== cid));
    } catch (err: any) {
      notify(String(err?.response?.data?.message ?? err?.message ?? "Impossible de supprimer la charge"));
    }
  };
  const reopenChargeForTest = async (charge: any) => {
    if (!window.confirm("Remettre cette charge a payer pour test ?")) return;
    try {
      if (FIREBASE_ONLY) {
        await setDoc(
          doc(budgetCollection("charges"), String(charge.id)),
          {
            paid_cents: 0,
            status: "prevue",
            isPaid: false,
            payment_mode: "",
            updated_at: new Date().toISOString()
          },
          { merge: true }
        );
      } else {
        await api.put(`/charges/${charge.id}`, {
          label: String(charge.label ?? ""),
          category: String(charge.category ?? ""),
          amountCents: Number(charge.amount_cents ?? 0),
          accountId: charge.account_id ?? null,
          expectedDate: String(charge.expected_date ?? ""),
          chargeType: String(charge.charge_type ?? "totale"),
          note: String(charge.note ?? "")
        });
      }
      const charges = FIREBASE_ONLY ? await firestoreGet(`/charges/${monthId}`) : (await api.get(`/charges/${monthId}`)).data;
      setRows(charges);
      await publishSyncEvent("charge-reopen");
      notify("Charge remise a payer");
    } catch (err: any) {
      const message = String(err?.response?.data?.message ?? err?.message ?? "Impossible de remettre la charge a payer");
      notify(message);
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setEditError("");
    const expectedDateYmd = parseDateDMY(editing.expected_date_input ?? formatDateDMY(editing.expected_date));
    if (!expectedDateYmd) {
      notify("Date invalide. Utilisez le format JJ/MM/AAAA");
      return;
    }
    const amountDhs = Number(editing.amount_input ?? "");
    const fallbackCents = Number(editing.amount_cents ?? 0);
    const normalizedAmountInput = String(editing.amount_input ?? "").replace(",", ".").trim();
    const parsedAmount = Number(normalizedAmountInput);
    const amountCents = Number.isFinite(parsedAmount) && parsedAmount > 0 ? Math.round(parsedAmount * 100) : Math.round(fallbackCents);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setEditError("Montant invalide. Entrez un montant > 0.");
      return;
    }
    const payload = {
      label: editing.label,
      category: editing.category,
      amountCents,
      accountId: editing.account_id && String(editing.account_id).length > 0 ? editing.account_id : null,
      expectedDate: expectedDateYmd,
      chargeType: editing.charge_type ?? "totale",
      note: editing.note ?? "",
      isRecurrent: Boolean(editing.is_recurrent),
      recurrenceFrequency: String(editing.recurrence_frequency ?? "monthly"),
      recurrenceRoot: String(editing.recurrence_root ?? editing.id)
    };
    const applyToFuture = Boolean(editing.is_recurrent) && window.confirm("Modifier tous les mois suivants ?\nOK = tous les mois suivants\nAnnuler = uniquement ce mois");
    try {
      setEditSaving(true);
      const nextRow = {
        ...editing,
        label: payload.label,
        category: payload.category,
        amount_cents: payload.amountCents,
        account_id: payload.accountId,
        expected_date: payload.expectedDate,
        charge_type: payload.chargeType,
        note: payload.note
      };
      if (FIREBASE_ONLY) {
        // Direct Firestore write avoids any HTTP/interceptor side effects on edit flow.
        await setDoc(
          doc(budgetCollection("charges"), String(editing.id)),
          {
            label: payload.label,
            category: payload.category,
            amount_cents: payload.amountCents,
            account_id: payload.accountId,
            expected_date: payload.expectedDate,
            charge_type: payload.chargeType,
            note: payload.note,
            is_recurrent: payload.isRecurrent,
            recurrence_frequency: payload.recurrenceFrequency,
            recurrence_root: payload.isRecurrent ? payload.recurrenceRoot : null,
            updated_at: new Date().toISOString()
          },
          { merge: true }
        );
        if (payload.isRecurrent && applyToFuture) {
          await firestoreApplyRecurringRuleToFuture("charges", payload.recurrenceRoot, monthId, {
            label: payload.label,
            category: payload.category,
            amount_cents: payload.amountCents,
            account_id: payload.accountId,
            expected_date: payload.expectedDate,
            note: payload.note,
            charge_type: payload.chargeType,
            is_recurrent: true,
            recurrence_frequency: payload.recurrenceFrequency,
            recurrence_root: payload.recurrenceRoot
          });
        }
        setRows((prev) => prev.map((r) => (String(r.id) === String(editing.id) ? { ...r, ...nextRow } : r)));
      }
      else await api.put(`/charges/${editing.id}`, payload);
      notify("Charge modifiee avec succes");
      setEditing(null);
      try {
        const res = await api.get(`/charges/${monthId}`);
        setRows(res.data);
      } catch {
        // Keep optimistic update when refresh fails.
      }
    } catch (err: any) {
      const message = String(err?.message ?? "Echec de modification de la charge");
      setEditError(message);
      notify(message);
    } finally {
      setEditSaving(false);
    }
  };

  return (
    <div className="stack">
      <h2>Charges</h2>
      <div className="accounts-grid">
        {sortedRows.map((r) => {
          const paid = Number(r.paid_cents ?? 0);
          const total = Number(r.amount_cents ?? 0);
          const remaining = Math.max(0, total - paid);
          const isPaid = remaining <= 0 || paid >= total;
          const isProgressive = (r.charge_type ?? "totale") === "progressive";
          const progressPct = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;
          const remainingLevel = remaining === 0 ? "ok" : remaining > total * 0.6 ? "high" : "normal";
          const Icon = chargeCategoryIcon(r.category);
          const statusLabel = isPaid ? "Paye" : paid > 0 ? "Partielle" : "Prevue";
          return (
            <div className={`card stack charge-card premium-charge ${isPaid ? "charge-card-paid" : ""}`} key={r.id}>
              <div className="row charge-head">
                <div className="row charge-title-wrap">
                  <span className="charge-icon-badge"><Icon size={18} /></span>
                  <div className="stack" style={{ gap: 2 }}>
                    <strong className="charge-title" title={String(r.label ?? "")}>{r.label}</strong>
                    <span className="muted charge-category">{r.category || "Autres"}</span>
                    {Boolean(r.is_recurrent) ? <span className="muted">Recurrent</span> : null}
                  </div>
                </div>
                <div className="stack align-end charge-values">
                  <span className={`charge-status-badge ${isPaid ? "is-paid" : ""}`}>{statusLabel}</span>
                  <span className="muted charge-kpi-label">Prevu</span>
                  <strong className="charge-kpi-main">{toMoney(total)}</strong>
                </div>
              </div>
              <div className="charge-stats-grid">
                <div className="charge-stat">
                  <span className="muted charge-kpi-label">Paye</span>
                  <strong>{toMoney(paid)}</strong>
                </div>
                <div className={`charge-stat charge-stat-remaining rem-${remainingLevel}`}>
                  <span className="muted charge-kpi-label">Reste a payer</span>
                  <strong>{toMoney(remaining)}</strong>
                </div>
              </div>
              <div className="stack charge-progress-block" style={{ gap: 6 }}>
                {isProgressive ? (
                  <>
                    <div className="row">
                      <span className="muted charge-kpi-label">Progression</span>
                      <strong className="charge-progress-pct">{progressPct}%</strong>
                    </div>
                    <div className="charge-progress-track">
                      <div className={`charge-progress-fill rem-${remainingLevel}`} style={{ width: `${progressPct}%` }} />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="row charge-progress-placeholder-label">
                      <span className="muted charge-kpi-label">Progression</span>
                      <strong className="charge-progress-pct">--</strong>
                    </div>
                    <div className="charge-progress-track charge-progress-placeholder-track" />
                  </>
                )}
              </div>
              <div className="row actions charge-actions">
                {!isProgressive && r.status !== "payee" && remaining > 0 && (
                  <button className="btn-action pay" title="Ouvrir le paiement (montant, compte, mode)" onClick={() => openPaymentModal(r)}>
                    <Wallet size={14} /> Payer
                  </button>
                )}
                {isProgressive && r.status !== "payee" && remaining > 0 && (
                  <button className="btn-action pay" onClick={() => openPaymentModal(r)}>
                    <Wallet size={14} /> Ajouter paiement
                  </button>
                )}
                {(r.status === "payee" || Number(r.paid_cents ?? 0) > 0) && (
                  <button className="btn-action pay" type="button" onClick={() => void reopenChargeForTest(r)}>
                    <Wallet size={14} /> Remettre a payer
                  </button>
                )}
                <button className="btn-action history" onClick={() => openHistoryModal(r)}>
                  <ReceiptText size={14} /> Historique
                </button>
                <button
                  className="btn-action edit"
                  title="Bouton Modifier : changer les informations d'une ligne"
                  onClick={() =>
                    setEditing({
                      ...r,
                      amount_input: (Number(r.amount_cents ?? 0) / 100).toFixed(2),
                      expected_date_input: formatDateDMY(r.expected_date)
                    })
                  }
                >
                  <Pencil size={14} /> Modifier
                </button>
                <button className="btn-action delete" title="Bouton Supprimer : supprimer uniquement apres confirmation" onClick={() => remove(r.id)}>
                  <Trash2 size={14} /> Supprimer
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={(e) => closeOnBackdropOnly(e, () => setEditing(null))}>
          <form className="modal card stack" onClick={stopModalPropagation} onMouseDown={stopModalPropagation} onPointerDown={stopModalPropagation} onSubmit={save}>
            <h3>Modifier charge</h3>
            <input value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} required />
            <input value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} required />
            <select value={editing.charge_type ?? "totale"} onChange={(e) => setEditing({ ...editing, charge_type: e.target.value })}>
              <option value="totale">charge totale</option>
              <option value="progressive">charge progressive</option>
            </select>
            <select value={editing.is_recurrent ? "yes" : "no"} onChange={(e) => setEditing({ ...editing, is_recurrent: e.target.value === "yes" })}>
              <option value="no">Recurrente: Non</option>
              <option value="yes">Recurrente: Oui</option>
            </select>
            {editing.is_recurrent ? (
              <select value={editing.recurrence_frequency ?? "monthly"} onChange={(e) => setEditing({ ...editing, recurrence_frequency: e.target.value })}>
                <option value="monthly">Tous les mois</option>
                <option value="bimonthly">Tous les 2 mois</option>
                <option value="yearly">Tous les ans</option>
              </select>
            ) : null}
            <input
              type="text"
              inputMode="decimal"
              placeholder="Montant (DHS)"
              value={editing.amount_input ?? ""}
              onChange={(e) => setEditing({ ...editing, amount_input: e.target.value })}
              required
            />
            <select value={editing.account_id ?? ""} onChange={(e) => setEditing({ ...editing, account_id: e.target.value })}>
              <option value="">A definir au paiement</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <input placeholder="Note (facultative)" value={editing.note ?? ""} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
            <input
              type="text"
              inputMode="numeric"
              placeholder="JJ/MM/AAAA"
              value={editing.expected_date_input ?? formatDateDMY(editing.expected_date)}
              onChange={(e) => setEditing({ ...editing, expected_date_input: e.target.value })}
              required
            />
            {editError ? <div className="error">{editError}</div> : null}
            <div className="row">
              <button disabled={editSaving}>{editSaving ? "Enregistrement..." : "Enregistrer"}</button>
              <button type="button" className="secondary" onClick={() => setEditing(null)}>Annuler</button>
            </div>
          </form>
        </div>
      )}

      {paymentCharge && (
        <div className="modal-backdrop" onClick={(e) => closeOnBackdropOnly(e, () => setPaymentCharge(null))}>
          <form className="modal card stack" onClick={stopModalPropagation} onMouseDown={stopModalPropagation} onPointerDown={stopModalPropagation} onSubmit={submitPayment}>
            <h3>{(paymentCharge.charge_type ?? "totale") === "progressive" ? "Ajouter un paiement" : "Payer"} — {paymentCharge.label}</h3>
            <input type="number" min="0.01" step="0.01" value={paymentForm.amount} onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })} placeholder="Montant paye (DHS)" required />
            <select value={paymentForm.accountId} onChange={(e) => setPaymentForm({ ...paymentForm, accountId: e.target.value })} required>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select value={paymentForm.paymentMode} onChange={(e) => setPaymentForm({ ...paymentForm, paymentMode: e.target.value })} required>
              <option value="espece">Espece</option>
              <option value="carte">Carte</option>
              <option value="virement">Virement</option>
              <option value="prelevement">Prelevement</option>
              <option value="autre">Autre</option>
            </select>
            <input
              type="text"
              inputMode="numeric"
              placeholder="JJ/MM/AAAA"
              value={paymentForm.paymentDate}
              onChange={(e) => setPaymentForm({ ...paymentForm, paymentDate: e.target.value })}
              required
            />
            <input value={paymentForm.note} onChange={(e) => setPaymentForm({ ...paymentForm, note: e.target.value })} placeholder="Note (facultative)" />
            <div className="row">
              <button type="submit" disabled={paymentSaving}>{paymentSaving ? "Paiement en cours..." : "Valider"}</button>
              <button type="button" className="secondary" onClick={() => setPaymentCharge(null)}>Annuler</button>
            </div>
            {paymentError ? <div className="error">{paymentError}</div> : null}
            <div className="stack">
              <strong>Historique des paiements</strong>
              {paymentHistory.length === 0 && <div className="muted">Aucun paiement pour le moment.</div>}
              {paymentHistory.map((p) => (
                <div className="row card" key={p.id}>
                  <div className="muted">{formatDateDMY(String(p.payment_date))} · {p.account_name} · {p.payment_mode || "-"} · {p.note || "-"}</div>
                  <strong>{toMoney(p.amount_cents)}</strong>
                </div>
              ))}
            </div>
          </form>
        </div>
      )}

      {historyCharge && (
        <div className="modal-backdrop" onClick={(e) => closeOnBackdropOnly(e, () => setHistoryCharge(null))}>
          <div className="modal card stack" onClick={stopModalPropagation} onMouseDown={stopModalPropagation} onPointerDown={stopModalPropagation}>
            <h3>Historique - {historyCharge.label}</h3>
            <div className="muted">Charges deja payees sur les 12 derniers mois (minimum) pour ce libelle.</div>
            {chargeHistoryRows.length === 0 && <div className="muted">Aucune charge payee sur cette periode.</div>}
            {chargeHistoryRows.map((p) => (
              <div className="row card" key={p.id}>
                <div className="muted">
                  {formatDateDMY(String(p.expected_date))} · {p.month_label || "-"} · {p.category || "-"} · {p.status || "-"}
                  {p.note ? ` · ${p.note}` : ""}
                </div>
                <strong>{toMoney(Number(p.paid_cents ?? p.amount_cents ?? 0))}</strong>
              </div>
            ))}
            <button className="secondary" onClick={() => setHistoryCharge(null)}>Fermer</button>
          </div>
        </div>
      )}
    </div>
  );
}

type HistoryOpFilter = "all" | "charge" | "resource" | "payment" | "transfer";
type HistoryExportMode = "current_month" | "all_data" | "charges_only" | "resources_only" | "justified";

function historyDisplayKind(r: any): string {
  const cat = String(r.category ?? "").toLowerCase();
  if (String(r.operation_group ?? "") === "resource") return "Ressource";
  if (cat === "transfert" || String(r.label ?? "").toLowerCase().includes("transfert")) return "Transfert";
  if (cat === "paiement_espece") return "Paiement";
  if (cat === "paiement_charge") return "Charge";
  if (cat === "ajustement") return "Ajustement";
  if (String(r.operation_group ?? "") === "charge") return "Charge";
  return "Autre";
}

function historyRowMatchesFilter(r: any, f: HistoryOpFilter): boolean {
  if (f === "all") return true;
  const cat = String(r.category ?? "");
  const og = String(r.operation_group ?? "");
  if (f === "resource") return og === "resource";
  if (f === "charge") return cat === "paiement_charge";
  if (f === "payment") return cat === "paiement_charge" || cat === "paiement_espece";
  if (f === "transfer") return cat === "transfert";
  return true;
}

function historyAccountLabel(r: any): string {
  const v = r.account_name ?? r.compte ?? r.account_label ?? r.accountName;
  return v ? String(v) : "-";
}

function rowsForHistoryExport(rows: any[], mode: HistoryExportMode): any[] {
  switch (mode) {
    case "current_month":
    case "all_data":
      return rows;
    case "charges_only":
      return rows.filter((r) => String(r.category ?? "") === "paiement_charge");
    case "resources_only":
      return rows.filter((r) => String(r.operation_group ?? "") === "resource");
    case "justified":
      return rows.filter(isHistoryJustifiedGapRow);
    default:
      return rows;
  }
}

function exportModeLabelFr(mode: HistoryExportMode): string {
  switch (mode) {
    case "current_month":
      return "Mois actuel";
    case "all_data":
      return "Toutes les donnees (mois affiche)";
    case "charges_only":
      return "Charges uniquement";
    case "resources_only":
      return "Ressources uniquement";
    case "justified":
      return "Ecarts justifies";
    default:
      return "Export";
  }
}

function isHistoryJustifiedGapRow(r: any) {
  return String(r.category ?? "").toLowerCase() === "ajustement" && String(r.note ?? "").trim().length > 0;
}

function writeHistoryPdfWindow(scopedRows: any[], scopeLabel: string) {
  const popup = window.open("", "_blank");
  if (!popup) return;
  const now = new Date();
  const generatedAt = now.toLocaleString("fr-FR");
  const lines = scopedRows
    .map((r) => {
      const date = formatDateDMY(String(r.created_at ?? ""));
      const kind = String(historyDisplayKind(r)).replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const label = String(r.label ?? "-").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const category = String(r.category ?? "-").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const status = String(r.status ?? "-").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const account = String(historyAccountLabel(r)).replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const note = String(r.note ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const amount = toMoney(Number(r.amount_cents ?? 0));
      return `<tr><td>${date}</td><td>${kind}</td><td>${label}</td><td>${category}</td><td>${status}</td><td>${account}</td><td>${note || "-"}</td><td style="text-align:right">${amount}</td></tr>`;
    })
    .join("");

  popup.document.write(`<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <title>Historique des operations</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 20px; color: #111; }
      h1 { margin: 0 0 6px; font-size: 20px; }
      .meta { margin-bottom: 14px; color: #555; font-size: 12px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #d0d7de; padding: 6px; font-size: 11px; }
      th { background: #f6f8fa; text-align: left; }
      .empty { margin-top: 12px; color: #666; }
    </style>
  </head>
  <body>
    <h1>Historique des operations — ${scopeLabel}</h1>
    <div class="meta">Genere le ${generatedAt}</div>
    ${
      scopedRows.length
        ? `<table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Nom</th>
                <th>Categorie</th>
                <th>Statut</th>
                <th>Compte</th>
                <th>Note</th>
                <th>Montant</th>
              </tr>
            </thead>
            <tbody>${lines}</tbody>
          </table>`
        : `<div class="empty">Aucune donnee a exporter.</div>`
    }
  </body>
</html>`);
  popup.document.close();
  popup.focus();
  popup.print();
}

function History({ monthId, dataRevision }: { monthId: string; dataRevision: number }) {
  const [rows, setRows] = useState<any[]>([]);
  const [historyFilter, setHistoryFilter] = useState<HistoryOpFilter>("all");
  const [search, setSearch] = useState("");
  const [exportMode, setExportMode] = useState<HistoryExportMode>("current_month");

  useEffect(() => {
    if (!monthId) {
      setRows([]);
      return;
    }
    api.get(`/history/${monthId}`).then((r) => setRows(r.data));
  }, [monthId, dataRevision]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!historyRowMatchesFilter(r, historyFilter)) return false;
      if (!q) return true;
      const blob = [r.label, r.type, r.category, r.note, r.status, historyDisplayKind(r), historyAccountLabel(r)]
        .map((x) => String(x ?? "").toLowerCase())
        .join(" ");
      return blob.includes(q);
    });
  }, [rows, historyFilter, search]);

  const runExportPdf = () => {
    const scoped = rowsForHistoryExport(rows, exportMode);
    writeHistoryPdfWindow(scoped, exportModeLabelFr(exportMode));
  };

  return (
    <div className="stack history-page">
      <h2 className="history-title">Historique</h2>

      <div className="history-toolbar card">
        <div className="history-filters" role="tablist" aria-label="Filtrer les operations">
          {(
            [
              ["all", "Tous"],
              ["charge", "Charges"],
              ["resource", "Ressources"],
              ["payment", "Paiements"],
              ["transfer", "Transferts"]
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={historyFilter === key ? "" : "secondary"}
              onClick={() => setHistoryFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="history-search-label">
          <span className="muted">Rechercher</span>
          <input
            type="search"
            className="history-search-input"
            placeholder="Nom, categorie, note…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoComplete="off"
          />
        </label>
      </div>

      <div className="history-export card">
        <div className="muted history-export-title">Exporter l&apos;historique</div>
        <div className="history-export-row">
          <select className="history-export-select" value={exportMode} onChange={(e) => setExportMode(e.target.value as HistoryExportMode)}>
            <option value="current_month">Exporter le mois actuel</option>
            <option value="all_data">Exporter toutes les donnees</option>
            <option value="charges_only">Exporter uniquement les charges</option>
            <option value="resources_only">Exporter uniquement les ressources</option>
            <option value="justified">Exporter les ecarts justifies</option>
          </select>
          <button type="button" className="secondary history-export-btn" onClick={runExportPdf}>
            Telecharger (PDF)
          </button>
        </div>
      </div>

      <div className="history-scroll">
        {filteredRows.length === 0 ? (
          <div className="muted history-empty">Aucune operation pour ce filtre.</div>
        ) : (
          filteredRows.map((r) => (
            <div className="card history-row" key={r.id}>
              <div className="history-row-top">
                <span className="history-kind">{historyDisplayKind(r)}</span>
                <strong className="history-amount">{toMoney(Number(r.amount_cents ?? 0))}</strong>
              </div>
              <div className="history-name">{String(r.label ?? r.type ?? "—")}</div>
              <div className="history-meta">
                <span>{formatDateDMY(String(r.created_at ?? ""))}</span>
                <span className="muted"> · {historyAccountLabel(r)}</span>
              </div>
              <div className="history-meta muted">
                {String(r.category ?? "—")}
                {r.status ? ` · ${String(r.status)}` : ""}
              </div>
              {r.note ? <div className="history-note muted">{String(r.note)}</div> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function List({
  title,
  rows,
  right,
  rightClass,
  actions,
  editing,
  onEditChange,
  onSaveEdit,
  accounts,
  editType
}: {
  title: string;
  rows: any[];
  right: (row: any) => string;
  rightClass?: (row: any) => string | undefined;
  actions?: (row: any) => JSX.Element;
  editing?: any | null;
  onEditChange?: (value: any) => void;
  onSaveEdit?: (e: FormEvent) => void;
  accounts?: any[];
  editType?: "resource" | "charge";
}) {
  return (
    <div className="stack">
      <h2>{title}</h2>
      {editing && onEditChange && onSaveEdit && (
        <form className="card stack" onSubmit={onSaveEdit}>
          <h3>Modifier</h3>
          {editType === "resource" ? (
            <select value={editing.type} onChange={(e) => onEditChange({ ...editing, type: e.target.value })}>
              {RESOURCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          ) : (
            <>
              <input value={editing.label} onChange={(e) => onEditChange({ ...editing, label: e.target.value })} required />
              <input value={editing.category} onChange={(e) => onEditChange({ ...editing, category: e.target.value })} required />
            </>
          )}
          <input type="number" value={editing.amount_cents} onChange={(e) => onEditChange({ ...editing, amount_cents: Number(e.target.value) })} required />
          <select value={editing.account_id} onChange={(e) => onEditChange({ ...editing, account_id: e.target.value })}>
            {accounts?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <input type="date" value={(editing.expected_date || "").slice(0, 10)} onChange={(e) => onEditChange({ ...editing, expected_date: e.target.value })} required />
          <div className="row">
            <button>Enregistrer</button>
            <button type="button" className="secondary" onClick={() => onEditChange(null)}>Annuler</button>
          </div>
        </form>
      )}
      {rows.map((r) => (
        <div className="row card" key={r.id}>
          <div>
            <strong>{r.label ?? r.type ?? r.category}</strong>
            <div className="muted">{formatDateDMY(r.expected_date ?? r.created_at)} · {r.status ?? "-"}</div>
          </div>
          <div className="stack align-end">
            <span className={rightClass?.(r)}>{right(r)}</span>
            {actions?.(r)}
          </div>
        </div>
      ))}
    </div>
  );
}

function QuickButtons({
  monthId,
  months,
  accounts,
  notify,
  onDataChanged
}: {
  monthId: string;
  months: any[];
  accounts: any[];
  notify: (msg: string) => void;
  onDataChanged: () => void;
}) {
  const defaultAccountId = useMemo(() => accounts[0]?.id ?? "", [accounts]);
  const sortedMonthsAsc = useMemo(() => sortMonthsChronoAsc(months), [months]);
  const [open, setOpen] = useState<"" | "resource" | "charge">("");
  const [suggestionTick, setSuggestionTick] = useState(0);
  const labelSuggestions = useMemo(() => readChargeSuggestions(LS_CHARGE_LABELS), [open, suggestionTick]);
  const categorySuggestions = useMemo(() => readChargeSuggestions(LS_CHARGE_CATEGORIES), [open, suggestionTick]);
  const makeDefaultResourceForm = (accountId: string) => ({
    type: "Autres",
    amount: "",
    accountId,
    expectedDate: formatDateDMY(todayYmd()),
    status: "prevue" as "prevue" | "recue",
    note: "",
    isRecurrent: false,
    recurrenceFrequency: "monthly" as RecurrenceFrequency
  });
  const [resourceForm, setResourceForm] = useState(() => makeDefaultResourceForm(defaultAccountId));
  const [chargeForm, setChargeForm] = useState({
    label: "",
    category: "",
    chargeType: "totale" as "totale" | "progressive",
    amount: "",
    expectedDate: formatDateDMY(todayYmd()),
    note: "",
    isRecurrent: false,
    recurrenceFrequency: "monthly" as RecurrenceFrequency
  });
  const [resourceTargetMonthId, setResourceTargetMonthId] = useState(monthId);
  const [resourceDuplicateAllMonths, setResourceDuplicateAllMonths] = useState(false);
  const [chargeTargetMonthId, setChargeTargetMonthId] = useState(monthId);
  const [chargeDuplicateAllMonths, setChargeDuplicateAllMonths] = useState(false);
  const [fabSubmitting, setFabSubmitting] = useState(false);

  useEffect(() => {
    setResourceTargetMonthId(monthId);
    setChargeTargetMonthId(monthId);
  }, [monthId]);

  const resetResourceQuickForm = () => setResourceForm(makeDefaultResourceForm(defaultAccountId));
  const resetChargeQuickForm = () =>
    setChargeForm({
      label: "",
      category: "",
      chargeType: "totale",
      amount: "",
      expectedDate: formatDateDMY(todayYmd()),
      note: "",
      isRecurrent: false,
      recurrenceFrequency: "monthly"
    });
  const closeQuickModal = () => {
    if (open === "resource") resetResourceQuickForm();
    if (open === "charge") resetChargeQuickForm();
    setResourceDuplicateAllMonths(false);
    setChargeDuplicateAllMonths(false);
    setOpen("");
  };

  useEffect(() => {
    if (!defaultAccountId) return;
    setResourceForm((prev) => ({ ...prev, accountId: defaultAccountId }));
  }, [defaultAccountId]);

  const submitResource = async (e: FormEvent) => {
    e.preventDefault();
    if (fabSubmitting) return;
    const expectedDateYmd = parseDateDMY(resourceForm.expectedDate);
    if (!expectedDateYmd) {
      notify("Date invalide. Utilisez le format JJ/MM/AAAA");
      return;
    }
    if (resourceForm.isRecurrent && resourceDuplicateAllMonths) {
      notify("Desactivez la recurrence pour dupliquer sur tous les mois, ou decochez « tous les mois ».");
      return;
    }
    const targetList = resourceDuplicateAllMonths ? sortedMonthsAsc : sortedMonthsAsc.filter((m: any) => m.id === resourceTargetMonthId);
    if (targetList.length === 0) {
      notify("Aucun mois disponible");
      return;
    }
    setFabSubmitting(true);
    try {
      for (const m of targetList) {
        const ymd = remapYmdSafeToMonthLabel(expectedDateYmd, String(m.label ?? ""));
        if (!ymd) {
          notify("Mois invalide dans la liste");
          return;
        }
        await api.post("/resources", {
          monthId: m.id,
          type: resourceForm.type,
          amountCents: Math.round(Number(resourceForm.amount) * 100),
          accountId: resourceForm.accountId,
          expectedDate: ymd,
          status: resourceForm.status,
          note: resourceForm.note,
          isRecurrent: resourceForm.isRecurrent,
          recurrenceFrequency: resourceForm.recurrenceFrequency
        });
      }
      onDataChanged();
      notify(targetList.length > 1 ? `Ressource ajoutee sur ${targetList.length} mois` : "Ressource ajoutee avec succes");
      closeQuickModal();
    } catch (err: any) {
      notify(String(err?.response?.data?.message ?? err?.message ?? "Echec creation ressource"));
    } finally {
      setFabSubmitting(false);
    }
  };

  const submitCharge = async (e: FormEvent) => {
    e.preventDefault();
    if (fabSubmitting) return;
    const expectedDateYmd = parseDateDMY(chargeForm.expectedDate);
    if (!expectedDateYmd) {
      notify("Date invalide. Utilisez le format JJ/MM/AAAA");
      return;
    }
    if (chargeForm.isRecurrent && chargeDuplicateAllMonths) {
      notify("Desactivez la recurrence pour dupliquer sur tous les mois, ou decochez « tous les mois ».");
      return;
    }
    const targetList = chargeDuplicateAllMonths ? sortedMonthsAsc : sortedMonthsAsc.filter((m: any) => m.id === chargeTargetMonthId);
    if (targetList.length === 0) {
      notify("Aucun mois disponible");
      return;
    }
    setFabSubmitting(true);
    try {
      for (const m of targetList) {
        const ymd = remapYmdSafeToMonthLabel(expectedDateYmd, String(m.label ?? ""));
        if (!ymd) {
          notify("Mois invalide dans la liste");
          return;
        }
        await api.post("/charges", {
          monthId: m.id,
          label: chargeForm.label.trim(),
          category: chargeForm.category.trim(),
          chargeType: chargeForm.chargeType,
          amountCents: Math.round(Number(chargeForm.amount) * 100),
          expectedDate: ymd,
          note: chargeForm.note,
          isRecurrent: chargeForm.isRecurrent,
          recurrenceFrequency: chargeForm.recurrenceFrequency
        });
      }
      onDataChanged();
      pushChargeSuggestion(LS_CHARGE_LABELS, chargeForm.label);
      pushChargeSuggestion(LS_CHARGE_CATEGORIES, chargeForm.category);
      setSuggestionTick((t) => t + 1);
      notify(
        targetList.length > 1
          ? `Charge ajoutee sur ${targetList.length} mois — a payer sur chaque mois`
          : "Charge ajoutee — a payer (utilisez Payer sur la carte)"
      );
      closeQuickModal();
    } catch (err: any) {
      notify(String(err?.response?.data?.message ?? err?.message ?? "Echec creation charge"));
    } finally {
      setFabSubmitting(false);
    }
  };

  return (
    <>
      <div className="fab-wrap" aria-label="Actions rapides">
        <button
          type="button"
          className="fab fab-plus plus"
          title="Bouton + : Ajouter une ressource recue ou prevue"
          onClick={() => {
            resetResourceQuickForm();
            setResourceTargetMonthId(monthId);
            setResourceDuplicateAllMonths(false);
            setOpen("resource");
          }}
        >
          +
        </button>
        <button
          type="button"
          className="fab fab-minus minus"
          title="Bouton - : Ajouter une charge payee ou prevue"
          onClick={() => {
            resetChargeQuickForm();
            setChargeTargetMonthId(monthId);
            setChargeDuplicateAllMonths(false);
            setOpen("charge");
          }}
        >
          -
        </button>
      </div>

      {open === "resource" && (
        <div className="modal-backdrop" onClick={(e) => closeOnBackdropOnly(e, closeQuickModal)}>
          <form className="modal card stack" onClick={stopModalPropagation} onMouseDown={stopModalPropagation} onPointerDown={stopModalPropagation} onSubmit={submitResource}>
            <h3>Ajouter une nouvelle ressource</h3>
            <label className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span className="muted">Mois budget</span>
              <select
                value={resourceTargetMonthId}
                disabled={resourceDuplicateAllMonths}
                onChange={(e) => setResourceTargetMonthId(e.target.value)}
                required
              >
                {sortedMonthsAsc.map((m: any) => (
                  <option key={m.id} value={m.id}>
                    {formatMonthLabel(String(m.label ?? "")).toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className="row" style={{ gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={resourceDuplicateAllMonths}
                onChange={(e) => {
                  setResourceDuplicateAllMonths(e.target.checked);
                  if (e.target.checked) setResourceForm((prev) => ({ ...prev, isRecurrent: false }));
                }}
              />
              <span>Créer sur tous les mois (date ajustee par mois)</span>
            </label>
            <select value={resourceForm.type} onChange={(e) => setResourceForm({ ...resourceForm, type: e.target.value })} required>
              {RESOURCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input type="number" min="0.01" step="0.01" placeholder="Montant" value={resourceForm.amount} onChange={(e) => setResourceForm({ ...resourceForm, amount: e.target.value })} required />
            <select value={resourceForm.accountId} onChange={(e) => setResourceForm({ ...resourceForm, accountId: e.target.value })} required>
              <option value="">Compte concerne</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <input
              type="text"
              inputMode="numeric"
              placeholder="JJ/MM/AAAA"
              value={resourceForm.expectedDate}
              onChange={(e) => setResourceForm({ ...resourceForm, expectedDate: e.target.value })}
              required
            />
            <select value={resourceForm.status} onChange={(e) => setResourceForm({ ...resourceForm, status: e.target.value as "prevue" | "recue" })}>
              <option value="prevue">Prevue</option>
              <option value="recue">Recue</option>
            </select>
            <select
              value={resourceForm.isRecurrent ? "yes" : "no"}
              disabled={resourceDuplicateAllMonths}
              onChange={(e) => setResourceForm({ ...resourceForm, isRecurrent: e.target.value === "yes" })}
            >
              <option value="no">Recurrente: Non</option>
              <option value="yes">Recurrente: Oui</option>
            </select>
            {resourceForm.isRecurrent && (
              <select value={resourceForm.recurrenceFrequency} onChange={(e) => setResourceForm({ ...resourceForm, recurrenceFrequency: e.target.value as RecurrenceFrequency })}>
                <option value="monthly">Tous les mois</option>
                <option value="bimonthly">Tous les 2 mois</option>
                <option value="yearly">Tous les ans</option>
              </select>
            )}
            <input placeholder="Note (facultative)" value={resourceForm.note} onChange={(e) => setResourceForm({ ...resourceForm, note: e.target.value })} />
            <div className="row">
              <button type="submit" disabled={fabSubmitting}>{fabSubmitting ? "..." : "Ajouter la ressource"}</button>
              <button type="button" className="secondary" onClick={closeQuickModal}>Annuler</button>
            </div>
          </form>
        </div>
      )}

      {open === "charge" && (
        <div className="modal-backdrop" onClick={(e) => closeOnBackdropOnly(e, closeQuickModal)}>
          <form className="modal card stack" onClick={stopModalPropagation} onMouseDown={stopModalPropagation} onPointerDown={stopModalPropagation} onSubmit={submitCharge}>
            <h3>Ajouter une nouvelle charge</h3>
            <label className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span className="muted">Mois budget</span>
              <select
                value={chargeTargetMonthId}
                disabled={chargeDuplicateAllMonths}
                onChange={(e) => setChargeTargetMonthId(e.target.value)}
                required
              >
                {sortedMonthsAsc.map((m: any) => (
                  <option key={m.id} value={m.id}>
                    {formatMonthLabel(String(m.label ?? "")).toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className="row" style={{ gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={chargeDuplicateAllMonths}
                onChange={(e) => {
                  setChargeDuplicateAllMonths(e.target.checked);
                  if (e.target.checked) setChargeForm((prev) => ({ ...prev, isRecurrent: false }));
                }}
              />
              <span>Créer sur tous les mois (date ajustee par mois)</span>
            </label>
            <select value={chargeForm.chargeType} onChange={(e) => setChargeForm({ ...chargeForm, chargeType: e.target.value as "totale" | "progressive" })}>
              <option value="totale">Charge totale</option>
              <option value="progressive">Charge progressive</option>
            </select>
            <datalist id="charge-label-suggestions">
              {labelSuggestions.map((s) => <option key={s} value={s} />)}
            </datalist>
            <datalist id="charge-category-suggestions">
              {categorySuggestions.map((s) => <option key={s} value={s} />)}
            </datalist>
            <input list="charge-label-suggestions" placeholder="Libelle" value={chargeForm.label} onChange={(e) => setChargeForm({ ...chargeForm, label: e.target.value })} required />
            <input list="charge-category-suggestions" placeholder="Categorie" value={chargeForm.category} onChange={(e) => setChargeForm({ ...chargeForm, category: e.target.value })} required />
            <input type="number" min="0.01" step="0.01" placeholder="Montant prevu (DHS)" value={chargeForm.amount} onChange={(e) => setChargeForm({ ...chargeForm, amount: e.target.value })} required />
            <input
              type="text"
              inputMode="numeric"
              placeholder="JJ/MM/AAAA"
              value={chargeForm.expectedDate}
              onChange={(e) => setChargeForm({ ...chargeForm, expectedDate: e.target.value })}
              required
            />
            <select
              value={chargeForm.isRecurrent ? "yes" : "no"}
              disabled={chargeDuplicateAllMonths}
              onChange={(e) => setChargeForm({ ...chargeForm, isRecurrent: e.target.value === "yes" })}
            >
              <option value="no">Recurrente: Non</option>
              <option value="yes">Recurrente: Oui</option>
            </select>
            {chargeForm.isRecurrent && (
              <select value={chargeForm.recurrenceFrequency} onChange={(e) => setChargeForm({ ...chargeForm, recurrenceFrequency: e.target.value as RecurrenceFrequency })}>
                <option value="monthly">Tous les mois</option>
                <option value="bimonthly">Tous les 2 mois</option>
                <option value="yearly">Tous les ans</option>
              </select>
            )}
            <input placeholder="Note (facultative)" value={chargeForm.note} onChange={(e) => setChargeForm({ ...chargeForm, note: e.target.value })} />
            <div className="row">
              <button type="submit" disabled={fabSubmitting}>{fabSubmitting ? "..." : "Ajouter la charge"}</button>
              <button type="button" className="secondary" onClick={closeQuickModal}>Annuler</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

export function App() {
  const nav = useNavigate();
  const { months, setMonthId, refreshMonths } = useMonth();
  const monthEnsureInFlightRef = useRef<string | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [dataRevision, setDataRevision] = useState(0);
  const [toast, setToast] = useState("");
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const refreshTimerRef = useRef<number | null>(null);
  const [activeMonthLabel, setActiveMonthLabel] = useState<string>(() => {
    const saved = localStorage.getItem("activeMonthLabel");
    return normalizeMonthLabelKey(saved || getMonthLabelKey(new Date()));
  });
  const [jumpMonth, setJumpMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const accountsRef = useRef<any[]>([]);
  const monthSwitchGuardRef = useRef<{ active: boolean; beforeByName: Map<string, number> }>({
    active: false,
    beforeByName: new Map()
  });

  const snapshotAccountsByName = useCallback((rows: any[]) => {
    const m = new Map<string, number>();
    for (const row of rows) {
      m.set(normalizeTextForCompare(String(row.name ?? "")), Number(row.balance_cents ?? 0));
    }
    return m;
  }, []);

  const beginMonthSwitchGuard = useCallback(() => {
    monthSwitchGuardRef.current = {
      active: true,
      beforeByName: snapshotAccountsByName(accounts)
    };
  }, [accounts, snapshotAccountsByName]);

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }, []);

  const bumpDataRevision = useCallback(() => {
    if (refreshTimerRef.current !== null) return;
    refreshTimerRef.current = window.setTimeout(() => {
      setDataRevision((r) => r + 1);
      refreshTimerRef.current = null;
    }, 120);
  }, []);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (activeMonthLabel) localStorage.setItem("activeMonthLabel", normalizeMonthLabelKey(activeMonthLabel));
  }, [activeMonthLabel]);

  const monthIndex = months.findIndex((m) => normalizeMonthLabelKey(m.label) === normalizeMonthLabelKey(activeMonthLabel));
  const currentMonth = monthIndex >= 0 ? months[monthIndex] : null;
  const activeMonthId = currentMonth?.id ?? "";

  /** Quand on navigue vers un mois (flèches / saut) sans document Firestore, le mois n’existait pas : pas d’id → pas de FAB, dashboard à zéro. On crée le mois (liaisons récurrentes gérées par firestoreCreateMonth). */
  useEffect(() => {
    const labelKey = normalizeMonthLabelKey(activeMonthLabel);
    if (!parseMonthLabel(labelKey)) return;
    const hasMonth = months.some((m) => normalizeMonthLabelKey(String(m.label ?? "")) === labelKey);
    if (hasMonth) {
      monthEnsureInFlightRef.current = null;
      return;
    }
    if (monthEnsureInFlightRef.current === labelKey) return;
    monthEnsureInFlightRef.current = labelKey;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.post("/months", { label: labelKey });
        const newId = String(res.data?.id ?? "");
        if (cancelled) return;
        await refreshMonths(newId || undefined);
        bumpDataRevision();
      } catch (err: any) {
        if (!cancelled) {
          notify(String(err?.response?.data?.message ?? err?.message ?? "Impossible de preparer ce mois"));
        }
      } finally {
        monthEnsureInFlightRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeMonthLabel, months, refreshMonths, notify, bumpDataRevision]);

  useEffect(() => {
    if (!activeMonthId) return;
    setMonthId((prev) => (prev === activeMonthId ? prev : activeMonthId));
  }, [activeMonthId, setMonthId]);

  useEffect(() => {
    const load = async () => {
      try {
        let next: any[] = [];
        if (activeMonthId) {
          const res = await api.get(`/accounts/${activeMonthId}`);
          next = Array.isArray(res.data) ? res.data : [];
        } else if (FIREBASE_ONLY) {
          const data = await firestoreGet("/accounts/global");
          next = Array.isArray(data) ? data : [];
        } else {
          setAccounts([]);
          return;
        }

        if (monthSwitchGuardRef.current.active) {
          const before = monthSwitchGuardRef.current.beforeByName;
          const after = snapshotAccountsByName(next);
          let changed = before.size !== after.size;
          if (!changed) {
            for (const [k, v] of before.entries()) {
              if ((after.get(k) ?? 0) !== v) {
                changed = true;
                break;
              }
            }
          }
          if (changed) next = accountsRef.current;
          monthSwitchGuardRef.current.active = false;
        }

        setAccounts(next);
      } catch {
        setAccounts([]);
      }
    };
    void load();
  }, [activeMonthId, snapshotAccountsByName]);

  const todayMonthLabel = getMonthLabelKey(new Date());
  const canNavigateMonths = true;
  const displayedMonthLabel = normalizeMonthLabelKey(activeMonthLabel);
  const displayedParsed = parseMonthLabel(displayedMonthLabel);
  const getNavigationBaseDate = () => {
    if (displayedParsed) return new Date(displayedParsed.year, displayedParsed.month - 1, 1);
    const fallback = parseMonthLabel(normalizeMonthLabelKey(getMonthLabelKey(new Date())));
    if (fallback) return new Date(fallback.year, fallback.month - 1, 1);
    return new Date();
  };

  const goPreviousMonth = () => {
    beginMonthSwitchGuard();
    const base = getNavigationBaseDate();
    const d = new Date(base.getFullYear(), base.getMonth() - 1, 1);
    const targetLabel = getMonthLabelKey(d);
    setActiveMonthLabel(normalizeMonthLabelKey(targetLabel));
    setShowMonthPicker(false);
    notify(`Mois actif: ${formatMonthLabel(targetLabel).toUpperCase()}`);
  };

  const goNextMonth = () => {
    beginMonthSwitchGuard();
    const base = getNavigationBaseDate();
    const d = new Date(base.getFullYear(), base.getMonth() + 1, 1);
    const targetLabel = getMonthLabelKey(d);
    setActiveMonthLabel(normalizeMonthLabelKey(targetLabel));
    setShowMonthPicker(false);
    notify(`Mois actif: ${formatMonthLabel(targetLabel).toUpperCase()}`);
  };

  const goTodayMonth = () => {
    beginMonthSwitchGuard();
    setActiveMonthLabel(normalizeMonthLabelKey(todayMonthLabel));
    setShowMonthPicker(false);
  };

  const jumpToMonth = () => {
    const jk = normalizeMonthLabelKey(jumpMonth);
    const parsedJump = parseMonthLabel(jk);
    if (!parsedJump) {
      notify("Format invalide, utilisez AAAA-MM");
      return;
    }
    beginMonthSwitchGuard();
    setActiveMonthLabel(jk);
    setShowMonthPicker(false);
    notify("Mois selectionne");
  };

  useEffect(() => {
    if (!SOCKET_BASE_URL) return;
    const socket = io(SOCKET_BASE_URL);
    socket.on("data:changed", () => bumpDataRevision());
    return () => {
      socket.disconnect();
    };
  }, [bumpDataRevision]);

  useEffect(() => {
    const unsub = subscribeSyncEvents(() => bumpDataRevision());
    return () => unsub();
  }, [bumpDataRevision]);

  if (loggedOut) return <Navigate to="/login" replace />;

  return (
    <div className="layout">
      <header className="card app-header">
        <div className="app-header-row">
          <h1 className="app-title">Budget Mensuel</h1>
          <button
            type="button"
            className="header-logout-btn"
            onClick={async () => {
              localStorage.removeItem("token");
              await firebaseLogout();
              setLoggedOut(true);
              nav("/login");
            }}
          >
            Déconnexion
          </button>
        </div>
        <div className="month-nav">
          <button type="button" className="month-arrow month-arrow-prev" onClick={goPreviousMonth} disabled={!canNavigateMonths} title="Mois precedent">
            <span aria-hidden="true">❮</span>
          </button>
          <button type="button" className="month-label month-label-btn" onClick={() => setShowMonthPicker((v) => !v)} title="Choisir rapidement un mois">
            {formatMonthLabel(displayedMonthLabel).toUpperCase()}
          </button>
          <button type="button" className="month-arrow month-arrow-next" onClick={goNextMonth} disabled={!canNavigateMonths} title="Mois suivant">
            <span aria-hidden="true">❯</span>
          </button>
          {showMonthPicker && (
            <div className="month-picker card">
              <div className="jump-row">
                <input type="month" value={jumpMonth} onChange={(e) => setJumpMonth(e.target.value)} />
                <button type="button" onClick={jumpToMonth}>Aller</button>
              </div>
              <button type="button" className="today-btn" onClick={goTodayMonth}>
                Aujourd'hui
              </button>
              <div className="month-picker-list">
                {months.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    className={`month-option ${normalizeMonthLabelKey(m.label) === displayedMonthLabel ? "active" : ""}`}
                    onClick={() => {
                      setActiveMonthLabel(normalizeMonthLabelKey(m.label));
                      setShowMonthPicker(false);
                    }}
                  >
                    {formatMonthLabel(m.label).toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </header>

      <nav className="tabs">
        <Link to="/">Tableau de bord</Link>
        <Link to="/comptes">Comptes</Link>
        <Link to="/ressources">Ressources</Link>
        <Link to="/charges">Charges</Link>
        <Link to="/historique">Historique</Link>
      </nav>

      <main key={activeMonthLabel} className="month-fade app-main">
        <Routes>
          <Route path="/" element={<Dashboard monthId={activeMonthId} dataRevision={dataRevision} />} />
          <Route path="/comptes" element={<Accounts monthId={activeMonthId} months={months} dataRevision={dataRevision} notify={notify} />} />
          <Route path="/ressources" element={<Resources monthId={activeMonthId} dataRevision={dataRevision} accounts={accounts} notify={notify} />} />
          <Route path="/charges" element={<Charges monthId={activeMonthId} dataRevision={dataRevision} accounts={accounts} notify={notify} />} />
          <Route path="/historique" element={<History monthId={activeMonthId} dataRevision={dataRevision} />} />
        </Routes>
      </main>

      {activeMonthId && (
        <QuickButtons
          monthId={activeMonthId}
          months={months}
          accounts={accounts}
          notify={notify}
          onDataChanged={async () => {
            bumpDataRevision();
            await publishSyncEvent("mutation");
          }}
        />
      )}
      <Toast message={toast} />
    </div>
  );
}
