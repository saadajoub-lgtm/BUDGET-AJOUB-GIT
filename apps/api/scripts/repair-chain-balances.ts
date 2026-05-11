/**
 * Recopie les soldes depuis le mois chronologiquement précédent lorsque le mois courant
 * a un total hors épargne à 0 et le précédent > 0.
 * Exécuter depuis apps/api : npm run repair-balances
 */
import {
  copyAccountBalancesFromMonth,
  findPredecessorMonthId,
  monthsSortedByStartsAt,
  sumOperationalBalancesCents
} from "../src/month-utils.js";

const ordered = monthsSortedByStartsAt();
let monthsUpdated = 0;
for (const m of ordered) {
  const predId = findPredecessorMonthId(m.id, m.starts_at);
  if (!predId) continue;
  const destOp = sumOperationalBalancesCents(m.id);
  const srcOp = sumOperationalBalancesCents(predId);
  if (destOp === 0 && srcOp > 0) {
    copyAccountBalancesFromMonth(m.id, predId);
    monthsUpdated += 1;
    console.log(`[repair] ${m.label} (${m.id.slice(0, 8)}…) ← mois precedent ${predId.slice(0, 8)}…`);
  }
}
console.log(`[repair] Termine. Mois mis a jour: ${monthsUpdated}.`);
