import { db } from "./db.js";

export function monthStartsAtMs(iso: string): number {
  const n = Date.parse(String(iso));
  return Number.isFinite(n) ? n : 0;
}

function isEpargneName(name: string): boolean {
  return String(name)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") === "EPARGNE";
}

/** Somme des soldes hors épargne pour un mois (cohérent avec le tableau de bord). */
export function sumOperationalBalancesCents(monthId: string): number {
  const rows = db.prepare("SELECT name, balance_cents FROM accounts WHERE month_id = ?").all(monthId) as Array<{
    name: string;
    balance_cents: number;
  }>;
  let s = 0;
  for (const r of rows) {
    if (!isEpargneName(r.name)) s += Math.round(Number(r.balance_cents));
  }
  return s;
}

/**
 * Mois le plus récent dont starts_at est strictement avant celui du nouveau mois.
 * Évite les pièges de comparaison SQL sur des chaînes ISO hétérogènes.
 */
export function findPredecessorMonthId(excludeMonthId: string, newStartsAtIso: string): string | undefined {
  const targetMs = monthStartsAtMs(newStartsAtIso);
  if (!targetMs) return undefined;
  const rows = db.prepare("SELECT id, starts_at FROM months WHERE id != ?").all(excludeMonthId) as Array<{
    id: string;
    starts_at: string;
  }>;
  let bestId: string | undefined;
  let bestMs = -Infinity;
  for (const r of rows) {
    const ms = monthStartsAtMs(r.starts_at);
    if (!ms) continue;
    if (ms < targetMs && ms > bestMs) {
      bestMs = ms;
      bestId = r.id;
    }
  }
  return bestId;
}

export function monthsSortedByStartsAt(): Array<{ id: string; label: string; starts_at: string }> {
  const rows = db
    .prepare("SELECT id, label, starts_at FROM months")
    .all() as Array<{ id: string; label: string; starts_at: string }>;
  return [...rows].sort((a, b) => {
    const da = monthStartsAtMs(a.starts_at);
    const db_ = monthStartsAtMs(b.starts_at);
    if (da !== db_) return da - db_;
    return a.id.localeCompare(b.id);
  });
}

/** Recopie les soldes compte par compte (même nom) depuis fromMonthId vers toMonthId. */
export function copyAccountBalancesFromMonth(toMonthId: string, fromMonthId: string): void {
  const src = db.prepare("SELECT name, balance_cents FROM accounts WHERE month_id = ?").all(fromMonthId) as Array<{
    name: string;
    balance_cents: number;
  }>;
  const dest = db.prepare("SELECT id, name FROM accounts WHERE month_id = ?").all(toMonthId) as Array<{
    id: string;
    name: string;
  }>;
  const byName = new Map(src.map((r) => [r.name, Math.round(Number(r.balance_cents))]));
  const upd = db.prepare("UPDATE accounts SET balance_cents = ? WHERE id = ?");
  for (const a of dest) {
    const bal = byName.get(a.name);
    if (bal !== undefined) upd.run(bal, a.id);
  }
}
