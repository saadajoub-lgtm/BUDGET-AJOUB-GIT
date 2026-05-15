import { db } from "./db.js";
import { monthsSortedByStartsAt } from "./month-utils.js";

/** Normalise pour comparer les noms de comptes (casse, espaces, accents). */
function normalizeAccountName(name: string): string {
  return String(name)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isEpargneAccountName(name: string): boolean {
  return normalizeAccountName(name) === "EPARGNE";
}

export type DashboardComputed = {
  monthId: string;
  label: string;
  /** Index du mois dans la liste chronologique (0 = premier mois budget). */
  moisIndexChrono: number;
  /** Libellés des mois utilisés pour la chaîne (ordre calcul). */
  chainLabels: string[];
  soldeActuel: number;
  epargne: number;
  ressourcesAVenir: number;
  chargesAVenir: number;
  soldeDepartDuMois: number;
  soldePrevuMoisPrecedentUtilise: number | null;
  soldeFinMoisPrevu: number;
};

/** Solde à jour hors épargne : tous les comptes du mois sauf épargne (même libellé légèrement différent en base). */
function sumSoldeAJourHorsEpargneCents(monthId: string): number {
  const rows = db.prepare("SELECT name, balance_cents FROM accounts WHERE month_id = ?").all(monthId) as Array<{
    name: string;
    balance_cents: number;
  }>;
  let s = 0;
  for (const row of rows) {
    if (!isEpargneAccountName(row.name)) {
      s += Math.round(Number(row.balance_cents));
    }
  }
  return s;
}

function balanceEpargneCents(monthId: string): number {
  const rows = db.prepare("SELECT name, balance_cents FROM accounts WHERE month_id = ?").all(monthId) as Array<{
    name: string;
    balance_cents: number;
  }>;
  for (const row of rows) {
    if (isEpargneAccountName(row.name)) {
      return Math.round(Number(row.balance_cents));
    }
  }
  return 0;
}

/** Ressources du mois encore au statut « prévue » (non reçues). */
function sumResourcesAVenirCents(monthId: string): number {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS amount
       FROM resources WHERE month_id = ? AND status = 'prevue'`
    )
    .get(monthId) as { amount: number };
  return Math.round(Number(r.amount));
}

/**
 * Charges à venir du mois : totales non soldées + restant dû sur les progressives encore « à payer ».
 */
function sumChargesAVenirCents(monthId: string): number {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents - COALESCE(paid_cents, 0)), 0) AS amount
       FROM charges
       WHERE month_id = ?
         AND status = 'prevue'
         AND COALESCE(paid_cents, 0) < amount_cents`
    )
    .get(monthId) as { amount: number };
  return Math.round(Number(r.amount));
}

function monthsOrderedChronologically(): Array<{ id: string; label: string }> {
  return monthsSortedByStartsAt().map(({ id, label }) => ({ id, label }));
}

/**
 * Règles affichées :
 * - Solde à jour = somme des comptes hors épargne pour le mois affiché.
 * - Solde de départ du mois = ce solde à jour (toujours le mois sélectionné).
 * - Solde prévu fin de mois = solde à jour + ressources à venir − charges à venir (du même mois).
 *
 * (La chaîne mois par mois n’est plus utilisée pour le KPI : après recopie des comptes, le prévu
 * doit suivre le solde à jour du mois courant.)
 */
export function computeDashboardForMonth(monthId: string): DashboardComputed {
  const ordered = monthsOrderedChronologically();
  const idx = ordered.findIndex((m) => m.id === monthId);
  if (idx < 0) {
    throw new Error("Mois introuvable");
  }

  const soldeActuel = sumSoldeAJourHorsEpargneCents(monthId);
  const epargne = balanceEpargneCents(monthId);
  const ressourcesAVenir = sumResourcesAVenirCents(monthId);
  const chargesAVenir = sumChargesAVenirCents(monthId);
  const soldeDepartDuMois = soldeActuel;
  /** Toujours cohérent avec les cartes : mois courant uniquement. */
  const moisCourant = ordered[idx].label === new Date().toISOString().slice(0, 7);
  const soldeFinMoisPrevu = Math.round((moisCourant ? soldeActuel : 0) + ressourcesAVenir - chargesAVenir);

  /** Référence : fin prévisionnelle « en chaîne » du mois chronologiquement précédent (logs / debug uniquement). */
  let soldePrevuMoisPrecedentUtilise: number | null = null;
  if (idx > 0) {
    let prevSoldePrevuFin: number | null = null;
    for (let i = 0; i < idx; i++) {
      const id = ordered[i].id;
      const sa = sumSoldeAJourHorsEpargneCents(id);
      const res = sumResourcesAVenirCents(id);
      const ch = sumChargesAVenirCents(id);
      const depart: number = i === 0 ? sa : (prevSoldePrevuFin as number);
      prevSoldePrevuFin = depart + res - ch;
    }
    soldePrevuMoisPrecedentUtilise = prevSoldePrevuFin;
  }

  return {
    monthId,
    label: ordered[idx].label,
    moisIndexChrono: idx,
    chainLabels: ordered.slice(0, idx + 1).map((m) => m.label),
    soldeActuel,
    epargne,
    ressourcesAVenir,
    chargesAVenir,
    soldeDepartDuMois,
    soldePrevuMoisPrecedentUtilise,
    soldeFinMoisPrevu
  };
}

/** Logs temporaires demandés pour contrôle (à retirer une fois validé). */
export function logDashboardDebug(metrics: DashboardComputed) {
  console.log("[dashboard][TEMP]", {
    moisActifLabel: metrics.label,
    moisActifId: metrics.monthId,
    moisIndexChrono: metrics.moisIndexChrono,
    chainLabels: metrics.chainLabels,
    soldeAJourHorsEpargneCentimes: metrics.soldeActuel,
    ressourcesAVenirCentimes: metrics.ressourcesAVenir,
    chargesAVenirCentimes: metrics.chargesAVenir,
    soldeDepartMoisCentimes: metrics.soldeDepartDuMois,
    soldePrevuMoisPrecedentUtiliseCentimes: metrics.soldePrevuMoisPrecedentUtilise,
    soldePrevuFinMoisCalculeCentimes: metrics.soldeFinMoisPrevu,
    epargneCentimes: metrics.epargne
  });
}
