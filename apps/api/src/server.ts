import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { z } from "zod";
import { ACCOUNT_NAMES } from "@budget/shared";
import { db } from "./db.js";
import { requireAuth, signToken, type AuthRequest } from "./auth.js";
import { computeDashboardForMonth, logDashboardDebug } from "./dashboard-metrics.js";
import {
  copyAccountBalancesFromMonth,
  findPredecessorMonthId,
  monthsSortedByStartsAt,
  sumOperationalBalancesCents
} from "./month-utils.js";

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

function broadcastSync() {
  io.emit("data:changed", { at: Date.now() });
}

function getAccountById(accountId: string) {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as
    | { id: string; month_id: string; name: string; balance_cents: number }
    | undefined;
}

/** Libellé mois normalisé YYYY-MM (évite 2026-6 vs 2026-06 qui cassent label < ?). */
function normalizeMonthLabelInput(label: string): string {
  const t = label.trim();
  const m = /^(\d{4})[-/](\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${String(Number(m[2])).padStart(2, "0")}`;
  return t;
}

/** Date normalisée YYYY-MM-DD sans conversion timezone. */
function normalizeDateYmdInput(value: string): string | null {
  const t = String(value ?? "").trim();
  if (!t) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function monthLabelKeyById(monthId: string): string | null {
  const row = db.prepare("SELECT label FROM months WHERE id = ?").get(monthId) as { label: string } | undefined;
  if (!row) return null;
  return normalizeMonthLabelInput(row.label);
}

function normalizeText(value: string): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isEpargneCategory(category: string): boolean {
  return normalizeText(category).includes("EPARGNE");
}

function getEpargneAccountId(monthId: string): string | null {
  const row = db.prepare("SELECT id FROM accounts WHERE month_id = ? AND name = 'EPARGNE'").get(monthId) as { id: string } | undefined;
  return row?.id ?? null;
}

app.post("/auth/register", (req, res) => {
  const body = z.object({ email: z.string().email(), password: z.string().min(4) }).safeParse(req.body);
  if (!body.success) return res.status(400).json(body.error.flatten());
  const id = randomUUID();
  try {
    db.prepare("INSERT INTO users (id, email, password, created_at) VALUES (?, ?, ?, ?)").run(
      id,
      body.data.email,
      body.data.password,
      new Date().toISOString()
    );
  } catch {
    return res.status(409).json({ message: "Email deja utilise" });
  }
  return res.json({ token: signToken(id) });
});

app.post("/auth/login", (req, res) => {
  const body = z.object({ email: z.string().email(), password: z.string().min(4) }).safeParse(req.body);
  if (!body.success) return res.status(400).json(body.error.flatten());
  const user = db.prepare("SELECT id FROM users WHERE email = ? AND password = ?").get(body.data.email, body.data.password) as
    | { id: string }
    | undefined;
  if (!user) return res.status(401).json({ message: "Identifiants invalides" });
  return res.json({ token: signToken(user.id) });
});

app.get("/months", requireAuth, (_req, res) => {
  res.json(db.prepare("SELECT * FROM months ORDER BY starts_at DESC").all());
});

app.post("/months", requireAuth, (req, res) => {
  const body = z.object({
    label: z.string().min(3),
    startsAt: z.string(),
    endsAt: z.string(),
    copyChargesFromMonthId: z.string().optional()
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json(body.error.flatten());
  const monthId = randomUUID();
  const normalizedLabel = normalizeMonthLabelInput(body.data.label);
  db.prepare("INSERT INTO months (id, label, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?)").run(
    monthId,
    normalizedLabel,
    body.data.startsAt,
    body.data.endsAt,
    new Date().toISOString()
  );

  const predecessorId = findPredecessorMonthId(monthId, body.data.startsAt);
  const previousBalances = new Map<string, number>();
  if (predecessorId) {
    const previousRows = db.prepare("SELECT name, balance_cents FROM accounts WHERE month_id = ?").all(predecessorId) as Array<{
      name: string;
      balance_cents: number;
    }>;
    for (const row of previousRows) previousBalances.set(row.name, row.balance_cents);
  }
  const insertAccount = db.prepare("INSERT INTO accounts (id, month_id, name, balance_cents) VALUES (?, ?, ?, ?)");
  for (const name of ACCOUNT_NAMES) insertAccount.run(randomUUID(), monthId, name, previousBalances.get(name) ?? 0);

  if (predecessorId) {
    const destOp = sumOperationalBalancesCents(monthId);
    const srcOp = sumOperationalBalancesCents(predecessorId);
    if (destOp === 0 && srcOp > 0) {
      copyAccountBalancesFromMonth(monthId, predecessorId);
      console.warn("[months] Recopie defensive des soldes (nouveau mois operationnel a 0, precedent > 0)", {
        monthId,
        predecessorId,
        label: normalizedLabel
      });
    }
  }

  if (body.data.copyChargesFromMonthId) {
    const charges = db.prepare("SELECT * FROM charges WHERE month_id = ?").all(body.data.copyChargesFromMonthId) as Array<any>;
    const sourceAccounts = db.prepare("SELECT id, name FROM accounts WHERE month_id = ?").all(body.data.copyChargesFromMonthId) as Array<{
      id: string;
      name: string;
    }>;
    const sourceAccountNameById = new Map(sourceAccounts.map((a) => [a.id, a.name]));
    const firstAccountByName = db.prepare("SELECT id FROM accounts WHERE month_id = ? AND name = ?").pluck();
    for (const c of charges) {
      const sourceName = c.account_id ? sourceAccountNameById.get(c.account_id) : undefined;
      const accountId = sourceName ? firstAccountByName.get(monthId, sourceName) : c.account_id ?? null;
      db.prepare(
        "INSERT INTO charges (id, month_id, label, category, amount_cents, paid_cents, account_id, expected_date, status, payment_mode, note, charge_type) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'prevue', '', ?, ?)"
      ).run(randomUUID(), monthId, c.label, c.category, c.amount_cents, accountId, c.expected_date, c.note ?? "", c.charge_type ?? "totale");
    }
  }
  broadcastSync();
  res.status(201).json({ id: monthId });
});

/**
 * Répare les mois déjà créés avec soldes à 0 : recopie les soldes du mois chronologiquement précédent (même noms de comptes).
 * À appeler une fois par mois concerné (ex. curl / Postman) après correction serveur.
 */
app.post("/months/:monthId/recopy-balances-from-previous", requireAuth, (req, res) => {
  const month = db.prepare("SELECT id, starts_at FROM months WHERE id = ?").get(req.params.monthId) as
    | { id: string; starts_at: string }
    | undefined;
  if (!month) return res.status(404).json({ message: "Mois introuvable" });
  const predId = findPredecessorMonthId(month.id, month.starts_at);
  if (!predId) return res.status(400).json({ message: "Aucun mois precedent chronologique" });
  copyAccountBalancesFromMonth(month.id, predId);
  broadcastSync();
  res.json({ ok: true, copiedFromMonthId: predId });
});

/**
 * Repare en une fois tous les mois dont le total hors epargne est 0 alors que le mois precedent en a : recopie les soldes.
 * Utile si des mois (juin, juillet…) ont ete crees avec l’ancienne logique.
 */
app.post("/months/repair-chain-balances", requireAuth, (_req, res) => {
  const ordered = monthsSortedByStartsAt();
  let monthsUpdated = 0;
  for (const m of ordered) {
    const predId = findPredecessorMonthId(m.id, m.starts_at);
    if (!predId) continue;
    if (sumOperationalBalancesCents(m.id) === 0 && sumOperationalBalancesCents(predId) > 0) {
      copyAccountBalancesFromMonth(m.id, predId);
      monthsUpdated += 1;
    }
  }
  broadcastSync();
  res.json({ ok: true, monthsUpdated });
});

app.get("/dashboard/:monthId", requireAuth, (req, res) => {
  try {
    const m = computeDashboardForMonth(req.params.monthId);
    logDashboardDebug(m);
    const wantDebug = req.query.debug === "1" || req.query.debug === "true";
    const payload: Record<string, unknown> = {
      soldeActuel: m.soldeActuel,
      soldeFinMoisPrevu: m.soldeFinMoisPrevu,
      epargne: m.epargne,
      chargesAVenir: m.chargesAVenir,
      ressourcesAVenir: m.ressourcesAVenir
    };
    if (wantDebug) {
      payload._debug = {
        monthId: m.monthId,
        label: m.label,
        moisIndexChrono: m.moisIndexChrono,
        chainLabels: m.chainLabels,
        soldeDepartDuMois: m.soldeDepartDuMois,
        soldePrevuMoisPrecedentUtilise: m.soldePrevuMoisPrecedentUtilise
      };
    }
    res.json(payload);
  } catch {
    res.status(404).json({ message: "Mois introuvable" });
  }
});

app.post("/accounts/:accountId/set-balance", requireAuth, (req, res) => {
  const body = z.object({ newBalanceCents: z.number().int(), adjustmentDate: z.string().optional(), note: z.string().optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json(body.error.flatten());
  const account = getAccountById(req.params.accountId);
  if (!account) return res.status(404).json({ message: "Compte introuvable" });
  const previous = account.balance_cents;
  const next = body.data.newBalanceCents;
  db.prepare("UPDATE accounts SET balance_cents = ? WHERE id = ?").run(next, account.id);
  db.prepare(
    "INSERT INTO account_adjustments (id, month_id, account_id, previous_balance_cents, new_balance_cents, delta_cents, adjustment_date, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(randomUUID(), account.month_id, account.id, previous, next, next - previous, body.data.adjustmentDate ?? new Date().toISOString(), body.data.note ?? "Modification manuelle");
  broadcastSync();
  res.json({ ok: true });
});

app.post("/transfers", requireAuth, (req, res) => {
  const body = z.object({
    monthId: z.string(),
    fromAccountId: z.string(),
    toAccountId: z.string(),
    amountCents: z.number().int().positive(),
    transferDate: z.string(),
    note: z.string().optional()
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json(body.error.flatten());
  if (body.data.fromAccountId === body.data.toAccountId) return res.status(400).json({ message: "Source et destination identiques" });
  const from = getAccountById(body.data.fromAccountId);
  const to = getAccountById(body.data.toAccountId);
  if (!from || !to) return res.status(404).json({ message: "Compte introuvable" });
  db.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?").run(body.data.amountCents, from.id);
  db.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?").run(body.data.amountCents, to.id);
  const id = randomUUID();
  db.prepare(
    "INSERT INTO transfers (id, month_id, from_account_id, to_account_id, amount_cents, transfer_date, note) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, body.data.monthId, from.id, to.id, body.data.amountCents, body.data.transferDate, body.data.note ?? "");
  broadcastSync();
  res.status(201).json({ id });
});

app.delete("/transfers/:id", requireAuth, (req, res) => {
  const transfer = db.prepare("SELECT * FROM transfers WHERE id = ?").get(req.params.id) as any;
  if (!transfer) return res.status(404).json({ message: "Transfert introuvable" });
  db.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?").run(transfer.amount_cents, transfer.from_account_id);
  db.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?").run(transfer.amount_cents, transfer.to_account_id);
  db.prepare("DELETE FROM transfers WHERE id = ?").run(req.params.id);
  broadcastSync();
  res.json({ ok: true });
});

app.delete("/account-adjustments/:id", requireAuth, (req, res) => {
  const adjustment = db.prepare("SELECT * FROM account_adjustments WHERE id = ?").get(req.params.id) as any;
  if (!adjustment) return res.status(404).json({ message: "Ajustement introuvable" });
  db.prepare("UPDATE accounts SET balance_cents = ? WHERE id = ?").run(adjustment.previous_balance_cents, adjustment.account_id);
  db.prepare("DELETE FROM account_adjustments WHERE id = ?").run(req.params.id);
  broadcastSync();
  res.json({ ok: true });
});

app.get("/accounts-history/:monthId", requireAuth, (req, res) => {
  const monthId = req.params.monthId;
  const accountId = String(req.query.accountId ?? "");
  const params = [monthId, accountId].filter(Boolean);
  const accountFilter = accountId ? " AND acc.id = ? " : "";

  const resources = db.prepare(
    `SELECT r.id, r.expected_date as date, 'ressource_recue' as type, r.amount_cents, r.amount_cents as delta_cents, acc.name as account_name, r.type as note, 'resource' as source
     FROM resources r JOIN accounts acc ON acc.id = r.account_id
     WHERE r.month_id = ? AND r.status = 'recue' ${accountFilter}`
  ).all(...params);
  const charges = db.prepare(
    `SELECT c.id, c.expected_date as date, 'charge_payee' as type, c.amount_cents, -c.amount_cents as delta_cents, acc.name as account_name, c.label as note, 'charge' as source
     FROM charges c JOIN accounts acc ON acc.id = c.account_id
     WHERE c.month_id = ? AND c.status = 'payee' ${accountFilter}`
  ).all(...params);
  const transfersOut = db.prepare(
    `SELECT t.id, t.transfer_date as date, 'transfert_sortant' as type, t.amount_cents, -t.amount_cents as delta_cents, f.name as account_name, ('Vers ' || tt.name || CASE WHEN t.note != '' THEN ' - ' || t.note ELSE '' END) as note, 'transfer' as source
     FROM transfers t JOIN accounts f ON f.id = t.from_account_id JOIN accounts tt ON tt.id = t.to_account_id
     WHERE t.month_id = ? ${accountId ? " AND f.id = ? " : ""}`
  ).all(...params);
  const transfersIn = db.prepare(
    `SELECT t.id, t.transfer_date as date, 'transfert_entrant' as type, t.amount_cents, t.amount_cents as delta_cents, tt.name as account_name, ('Depuis ' || f.name || CASE WHEN t.note != '' THEN ' - ' || t.note ELSE '' END) as note, 'transfer' as source
     FROM transfers t JOIN accounts f ON f.id = t.from_account_id JOIN accounts tt ON tt.id = t.to_account_id
     WHERE t.month_id = ? ${accountId ? " AND tt.id = ? " : ""}`
  ).all(...params);
  const adjustments = db.prepare(
    `SELECT a.id, a.adjustment_date as date, 'modification_manuelle' as type, ABS(a.delta_cents) as amount_cents, a.delta_cents as delta_cents, acc.name as account_name,
      (CASE WHEN a.delta_cents >= 0 THEN 'Ajustement +' ELSE 'Ajustement -' END) || CASE WHEN a.note IS NOT NULL AND a.note != '' THEN ' - ' || a.note ELSE '' END as note, 'adjustment' as source
     FROM account_adjustments a JOIN accounts acc ON acc.id = a.account_id
     WHERE a.month_id = ? ${accountFilter}`
  ).all(...params);
  const chargePayments = db.prepare(
    `SELECT p.id, p.payment_date as date, 'paiement_charge_progressive' as type, p.amount_cents, -p.amount_cents as delta_cents, acc.name as account_name,
      (c.label || CASE WHEN p.note IS NOT NULL AND p.note != '' THEN ' - ' || p.note ELSE '' END) as note, 'charge_payment' as source
     FROM charge_payments p
     JOIN accounts acc ON acc.id = p.account_id
     JOIN charges c ON c.id = p.charge_id
     WHERE p.month_id = ? ${accountFilter}`
  ).all(...params);

  res.json([...resources, ...charges, ...transfersOut, ...transfersIn, ...adjustments, ...chargePayments].sort((a: any, b: any) => String(b.date).localeCompare(String(a.date))));
});

app.get("/accounts/:monthId", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM accounts WHERE month_id = ? ORDER BY name").all(req.params.monthId));
});

app.get("/resources/:monthId", requireAuth, (req, res) => {
  const monthKey = monthLabelKeyById(req.params.monthId);
  if (!monthKey) return res.status(404).json({ message: "Mois introuvable" });
  res.json(
    db.prepare("SELECT * FROM resources WHERE month_id = ? AND substr(expected_date, 1, 7) = ? ORDER BY expected_date ASC").all(req.params.monthId, monthKey)
  );
});

app.post("/resources", requireAuth, (req: AuthRequest, res) => {
  const body = z.object({
    monthId: z.string(),
    type: z.string(),
    amountCents: z.number().int().positive(),
    accountId: z.string(),
    expectedDate: z.string(),
    status: z.enum(["prevue", "recue"]),
    note: z.string().optional()
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json(body.error.flatten());
  const expectedDate = normalizeDateYmdInput(body.data.expectedDate);
  if (!expectedDate) return res.status(400).json({ message: "Date ressource invalide (format attendu YYYY-MM-DD)" });
  const postedMonthKey = monthLabelKeyById(body.data.monthId);
  if (!postedMonthKey) return res.status(404).json({ message: "Mois introuvable" });
  if (expectedDate.slice(0, 7) !== postedMonthKey) {
    return res.status(400).json({ message: `La date doit appartenir au mois actif (${postedMonthKey}).` });
  }
  const account = getAccountById(body.data.accountId);
  if (!account) return res.status(404).json({ message: "Compte introuvable" });
  if (account.name === "EPARGNE") return res.status(400).json({ message: "Le compte EPARGNE s'alimente via transfert uniquement" });
  const id = randomUUID();
  db.prepare("INSERT INTO resources (id, month_id, type, amount_cents, account_id, expected_date, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, body.data.monthId, body.data.type, body.data.amountCents, body.data.accountId, expectedDate, body.data.status, body.data.note ?? ""
  );
  if (body.data.status === "recue") db.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?").run(body.data.amountCents, body.data.accountId);
  broadcastSync();
  res.status(201).json({ id });
});

app.patch("/resources/:id/status", requireAuth, (req, res) => {
  const body = z.object({ status: z.enum(["prevue", "recue"]) }).safeParse(req.body);
  if (!body.success) return res.status(400).json(body.error.flatten());
  const row = db.prepare("SELECT * FROM resources WHERE id = ?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ message: "Ressource introuvable" });
  const account = getAccountById(row.account_id);
  if (!account) return res.status(404).json({ message: "Compte introuvable" });
  if (account.name === "EPARGNE") return res.status(400).json({ message: "Le compte EPARGNE s'alimente via transfert uniquement" });
  if (row.status === body.data.status) return res.json({ ok: true });
  if (row.status === "prevue" && body.data.status === "recue") db.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?").run(row.amount_cents, row.account_id);
  if (row.status === "recue" && body.data.status === "prevue") db.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?").run(row.amount_cents, row.account_id);
  db.prepare("UPDATE resources SET status = ? WHERE id = ?").run(body.data.status, req.params.id);
  broadcastSync();
  res.json({ ok: true });
});

app.put("/resources/:id", requireAuth, (req, res) => {
  const body = z.object({ type: z.string(), amountCents: z.number().int().positive(), accountId: z.string(), expectedDate: z.string() }).safeParse(req.body);
  if (!body.success) return res.status(400).json(body.error.flatten());
  const expectedDate = normalizeDateYmdInput(body.data.expectedDate);
  if (!expectedDate) return res.status(400).json({ message: "Date ressource invalide (format attendu YYYY-MM-DD)" });
  const row = db.prepare("SELECT * FROM resources WHERE id = ?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ message: "Ressource introuvable" });
  const monthKey = monthLabelKeyById(row.month_id);
  if (!monthKey) return res.status(404).json({ message: "Mois de la ressource introuvable" });
  if (expectedDate.slice(0, 7) !== monthKey) {
    return res.status(400).json({ message: `La date doit appartenir au mois actif (${monthKey}).` });
  }
  const account = getAccountById(body.data.accountId);
  if (!account) return res.status(404).json({ message: "Compte introuvable" });
  if (account.name === "EPARGNE") return res.status(400).json({ message: "Le compte EPARGNE s'alimente via transfert uniquement" });
  if (row.status === "recue") {
    db.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?").run(row.amount_cents, row.account_id);
    db.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?").run(body.data.amountCents, body.data.accountId);
  }
  db.prepare("UPDATE resources SET type = ?, amount_cents = ?, account_id = ?, expected_date = ? WHERE id = ?").run(
    body.data.type, body.data.amountCents, body.data.accountId, expectedDate, req.params.id
  );
  broadcastSync();
  res.json({ ok: true });
});

app.get("/resources/:id/annual-history", requireAuth, (req, res) => {
  const row = db.prepare("SELECT id, type, expected_date FROM resources WHERE id = ?").get(req.params.id) as
    | { id: string; type: string; expected_date: string }
    | undefined;
  if (!row) return res.status(404).json({ message: "Ressource introuvable" });
  const referenceDate = normalizeDateYmdInput(row.expected_date) ?? new Date().toISOString().slice(0, 10);
  const ref = new Date(`${referenceDate}T00:00:00`);
  const from = new Date(ref);
  from.setFullYear(from.getFullYear() - 1);
  const fromYmd = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-${String(from.getDate()).padStart(2, "0")}`;
  const rows = db
    .prepare(
      `SELECT r.id, r.type, r.amount_cents, r.expected_date, r.status, r.note, a.name as account_name, m.label as month_label
       FROM resources r
       LEFT JOIN accounts a ON a.id = r.account_id
       LEFT JOIN months m ON m.id = r.month_id
       WHERE r.type = ?
         AND r.expected_date >= ?
         AND r.expected_date <= ?
       ORDER BY r.expected_date DESC`
    )
    .all(row.type, fromYmd, referenceDate);
  res.json(rows);
});

app.delete("/resources/:id", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM resources WHERE id = ?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ message: "Ressource introuvable" });
  if (row.status === "recue") db.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?").run(row.amount_cents, row.account_id);
  db.prepare("DELETE FROM resources WHERE id = ?").run(req.params.id);
  broadcastSync();
  res.json({ ok: true });
});

app.get("/charges/:monthId", requireAuth, (req, res) => {
  db.prepare("UPDATE charges SET status = 'payee' WHERE month_id = ? AND paid_cents >= amount_cents").run(req.params.monthId);
  db.prepare("UPDATE charges SET status = 'prevue' WHERE month_id = ? AND paid_cents < amount_cents AND status = 'payee'").run(req.params.monthId);
  res.json(
    db
      .prepare(
        "SELECT *, COALESCE(charge_type, 'totale') as charge_type FROM charges WHERE month_id = ? ORDER BY expected_date ASC"
      )
      .all(req.params.monthId)
  );
});

app.post("/charges", requireAuth, (req, res) => {
  const body = z.object({
    monthId: z.string(),
    label: z.string().min(2),
    category: z.string().min(2),
    amountCents: z.number().int().positive(),
    expectedDate: z.string(),
    chargeType: z.enum(["totale", "progressive"]).optional(),
    note: z.string().optional()
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json(body.error.flatten());
  const expectedDate = normalizeDateYmdInput(body.data.expectedDate);
  if (!expectedDate) return res.status(400).json({ message: "Date charge invalide (format attendu YYYY-MM-DD)" });
  const postedMonthKey = monthLabelKeyById(body.data.monthId);
  if (!postedMonthKey) return res.status(404).json({ message: "Mois introuvable" });
  if (expectedDate.slice(0, 7) !== postedMonthKey) {
    return res.status(400).json({ message: `La date doit appartenir au mois actif (${postedMonthKey}).` });
  }
  const id = randomUUID();
  db.prepare("INSERT INTO charges (id, month_id, label, category, amount_cents, paid_cents, account_id, expected_date, status, payment_mode, note, charge_type) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, 'prevue', '', ?, ?)").run(
    id,
    body.data.monthId,
    body.data.label,
    body.data.category,
    body.data.amountCents,
    expectedDate,
    body.data.note ?? "",
    body.data.chargeType ?? "totale"
  );
  broadcastSync();
  res.status(201).json({ id });
});

app.patch("/charges/:id/status", requireAuth, (req, res) => {
  const body = z.object({ status: z.enum(["prevue", "payee"]) }).safeParse(req.body);
  if (!body.success) return res.status(400).json(body.error.flatten());
  const row = db.prepare("SELECT * FROM charges WHERE id = ?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ message: "Charge introuvable" });
  if (row.status === body.data.status) return res.json({ ok: true });
  if (row.status === "prevue" && body.data.status === "payee") {
    if (!row.account_id) return res.status(400).json({ message: "Cette charge se regle via le flux Paiement" });
    const delta = row.amount_cents - row.paid_cents;
    db.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?").run(delta, row.account_id);
    if (isEpargneCategory(row.category)) {
      const epargneId = getEpargneAccountId(row.month_id);
      if (!epargneId) return res.status(404).json({ message: "Compte EPARGNE introuvable" });
      db.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?").run(delta, epargneId);
    }
    db.prepare("UPDATE charges SET paid_cents = amount_cents, status = 'payee' WHERE id = ?").run(req.params.id);
  }
  if (row.status === "payee" && body.data.status === "prevue") {
    if (!row.account_id) return res.status(400).json({ message: "Impossible de remettre en prevue sans compte historique" });
    db.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?").run(row.amount_cents, row.account_id);
    if (isEpargneCategory(row.category)) {
      const epargneId = getEpargneAccountId(row.month_id);
      if (!epargneId) return res.status(404).json({ message: "Compte EPARGNE introuvable" });
      db.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?").run(row.amount_cents, epargneId);
    }
    db.prepare("UPDATE charges SET paid_cents = 0, status = 'prevue' WHERE id = ?").run(req.params.id);
  }
  broadcastSync();
  res.json({ ok: true });
});

app.put("/charges/:id", requireAuth, (req, res) => {
  const body = z.object({
    label: z.string().min(2),
    category: z.string().min(2),
    amountCents: z.number().int().positive(),
    accountId: z.string().optional().nullable(),
    expectedDate: z.string(),
    chargeType: z.enum(["totale", "progressive"]).optional(),
    note: z.string().optional()
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json(body.error.flatten());
  const expectedDate = normalizeDateYmdInput(body.data.expectedDate);
  if (!expectedDate) return res.status(400).json({ message: "Date charge invalide (format attendu YYYY-MM-DD)" });
  const row = db.prepare("SELECT * FROM charges WHERE id = ?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ message: "Charge introuvable" });
  const currentMonthKey = monthLabelKeyById(row.month_id);
  if (!currentMonthKey) return res.status(404).json({ message: "Mois de la charge introuvable" });
  if (expectedDate.slice(0, 7) !== currentMonthKey) {
    return res.status(400).json({ message: `La date doit appartenir au mois actif (${currentMonthKey}).` });
  }
  const payCount = db.prepare("SELECT COUNT(*) as n FROM charge_payments WHERE charge_id = ?").get(req.params.id) as { n: number };
  const nextAccountId = body.data.accountId && String(body.data.accountId).length > 0 ? body.data.accountId : null;
  if (row.status === "payee" && payCount.n === 0 && row.account_id && nextAccountId) {
    db.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?").run(row.amount_cents, row.account_id);
    db.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?").run(body.data.amountCents, nextAccountId);
  }
  const nextNote = body.data.note !== undefined ? body.data.note : row.note ?? "";
  db.prepare("UPDATE charges SET month_id = ?, label = ?, category = ?, amount_cents = ?, account_id = ?, expected_date = ?, charge_type = ?, note = ? WHERE id = ?").run(
    row.month_id,
    body.data.label,
    body.data.category,
    body.data.amountCents,
    nextAccountId,
    expectedDate,
    body.data.chargeType ?? row.charge_type ?? "totale",
    nextNote,
    req.params.id
  );
  db.prepare("UPDATE charge_payments SET month_id = ? WHERE charge_id = ?").run(row.month_id, req.params.id);
  broadcastSync();
  res.json({ ok: true });
});

app.get("/charges/:id/payments", requireAuth, (req, res) => {
  res.json(
    db.prepare(
      `SELECT p.*, a.name as account_name
       FROM charge_payments p
       JOIN accounts a ON a.id = p.account_id
       WHERE p.charge_id = ?
       ORDER BY p.payment_date DESC`
    ).all(req.params.id)
  );
});

app.get("/charges/:id/annual-history", requireAuth, (req, res) => {
  const charge = db.prepare("SELECT id, label, category, expected_date FROM charges WHERE id = ?").get(req.params.id) as
    | { id: string; label: string; category: string; expected_date: string }
    | undefined;
  if (!charge) return res.status(404).json({ message: "Charge introuvable" });
  const referenceDate = normalizeDateYmdInput(charge.expected_date) ?? new Date().toISOString().slice(0, 10);
  const ref = new Date(`${referenceDate}T00:00:00`);
  const from = new Date(ref);
  from.setFullYear(from.getFullYear() - 1);
  const fromYmd = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-${String(from.getDate()).padStart(2, "0")}`;

  const rows = db
    .prepare(
      `SELECT c.id, c.label, c.category, c.expected_date, c.amount_cents, c.paid_cents, c.status, c.charge_type, c.note, m.label as month_label
       FROM charges c
       LEFT JOIN months m ON m.id = c.month_id
       WHERE c.label = ?
         AND c.expected_date >= ?
         AND c.expected_date <= ?
         AND (c.status = 'payee' OR c.paid_cents > 0)
       ORDER BY c.expected_date DESC`
    )
    .all(charge.label, fromYmd, referenceDate);
  res.json(rows);
});

app.post("/charges/:id/payments", requireAuth, (req, res) => {
  const body = z.object({
    accountId: z.string(),
    amountCents: z.number().int().positive(),
    paymentDate: z.string(),
    paymentMode: z.string().optional(),
    note: z.string().optional()
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json(body.error.flatten());
  const charge = db.prepare("SELECT * FROM charges WHERE id = ?").get(req.params.id) as any;
  if (!charge) return res.status(404).json({ message: "Charge introuvable" });
  const account = getAccountById(body.data.accountId);
  if (!account) return res.status(404).json({ message: "Compte introuvable" });
  const remaining = Math.max(0, charge.amount_cents - charge.paid_cents);
  if (body.data.amountCents > remaining) return res.status(400).json({ message: "Montant superieur au restant" });
  db.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?").run(body.data.amountCents, body.data.accountId);
  if (isEpargneCategory(charge.category)) {
    const epargneId = getEpargneAccountId(charge.month_id);
    if (!epargneId) return res.status(404).json({ message: "Compte EPARGNE introuvable" });
    db.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?").run(body.data.amountCents, epargneId);
  }
  db.prepare("UPDATE charges SET paid_cents = paid_cents + ? WHERE id = ?").run(body.data.amountCents, charge.id);
  db.prepare("UPDATE charges SET status = 'payee' WHERE id = ? AND paid_cents >= amount_cents").run(charge.id);
  db.prepare("UPDATE charges SET account_id = ? WHERE id = ? AND account_id IS NULL").run(body.data.accountId, charge.id);
  const paymentId = randomUUID();
  db.prepare(
    "INSERT INTO charge_payments (id, month_id, charge_id, account_id, amount_cents, payment_date, note, payment_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    paymentId,
    charge.month_id,
    charge.id,
    body.data.accountId,
    body.data.amountCents,
    body.data.paymentDate,
    body.data.note ?? "",
    body.data.paymentMode ?? ""
  );
  broadcastSync();
  res.status(201).json({ id: paymentId });
});

app.delete("/charges/:id", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM charges WHERE id = ?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ message: "Charge introuvable" });
  const payments = db.prepare("SELECT account_id, amount_cents FROM charge_payments WHERE charge_id = ?").all(req.params.id) as Array<{
    account_id: string;
    amount_cents: number;
  }>;
  for (const p of payments) {
    db.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?").run(p.amount_cents, p.account_id);
  }
  if (isEpargneCategory(row.category) && Number(row.paid_cents ?? 0) > 0) {
    const epargneId = getEpargneAccountId(row.month_id);
    if (!epargneId) return res.status(404).json({ message: "Compte EPARGNE introuvable" });
    db.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?").run(row.paid_cents, epargneId);
  }
  db.prepare("DELETE FROM charge_payments WHERE charge_id = ?").run(req.params.id);
  if (row.status === "payee" && payments.length === 0 && row.account_id) {
    db.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?").run(row.amount_cents, row.account_id);
  }
  db.prepare("DELETE FROM charges WHERE id = ?").run(req.params.id);
  broadcastSync();
  res.json({ ok: true });
});

app.post("/cash-payment", requireAuth, (req, res) => {
  const body = z.object({ monthId: z.string(), chargeId: z.string(), amountCents: z.number().int().positive() }).safeParse(req.body);
  if (!body.success) return res.status(400).json(body.error.flatten());
  const charge = db.prepare("SELECT * FROM charges WHERE id = ?").get(body.data.chargeId) as any;
  if (!charge) return res.status(404).json({ message: "Charge introuvable" });
  db.prepare("UPDATE charges SET paid_cents = paid_cents + ? WHERE id = ?").run(body.data.amountCents, body.data.chargeId);
  db.prepare("UPDATE charges SET status = 'payee' WHERE id = ? AND paid_cents >= amount_cents").run(body.data.chargeId);
  const cash = db.prepare("SELECT id FROM accounts WHERE month_id = ? AND name = 'ESPECE'").get(body.data.monthId) as { id: string } | undefined;
  if (!cash) return res.status(404).json({ message: "Compte espece introuvable" });
  db.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?").run(body.data.amountCents, cash.id);
  if (isEpargneCategory(charge.category)) {
    const epargneId = getEpargneAccountId(charge.month_id);
    if (!epargneId) return res.status(404).json({ message: "Compte EPARGNE introuvable" });
    db.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?").run(body.data.amountCents, epargneId);
  }
  db.prepare("INSERT INTO cash_history (id, month_id, charge_id, amount_cents, created_at) VALUES (?, ?, ?, ?, ?)").run(
    randomUUID(), body.data.monthId, body.data.chargeId, body.data.amountCents, new Date().toISOString()
  );
  broadcastSync();
  res.json({ ok: true });
});

app.post("/local-reset", requireAuth, (_req, res) => {
  const clearResources = db.prepare("DELETE FROM resources");
  const clearCharges = db.prepare("DELETE FROM charges");
  const clearTransfers = db.prepare("DELETE FROM transfers");
  const clearCashHistory = db.prepare("DELETE FROM cash_history");
  const clearAdjustments = db.prepare("DELETE FROM account_adjustments");
  const resetAccounts = db.prepare("UPDATE accounts SET balance_cents = 0");

  const tx = db.transaction(() => {
    clearResources.run();
    clearCharges.run();
    clearTransfers.run();
    clearCashHistory.run();
    clearAdjustments.run();
    resetAccounts.run();
  });

  tx();
  broadcastSync();
  res.json({ ok: true, message: "Donnees locales reinitialisees avec succes" });
});

app.get("/history/:monthId", requireAuth, (req, res) => {
  const resourcesRows = db
    .prepare(
      `SELECT r.id,
              r.amount_cents,
              r.expected_date as created_at,
              r.type as label,
              'ressource' as category,
              r.status as status,
              COALESCE(r.note, '') as note,
              'resource' as operation_group
       FROM resources r
       WHERE r.month_id = ?
         AND r.status = 'recue'`
    )
    .all(req.params.monthId) as Array<any>;
  const chargePaymentsRows = db
    .prepare(
      `SELECT p.id,
              -p.amount_cents as amount_cents,
              p.payment_date as created_at,
              c.label as label,
              'paiement_charge' as category,
              'payee' as status,
              COALESCE(p.note, '') as note,
              'charge' as operation_group
       FROM charge_payments p
       JOIN charges c ON c.id = p.charge_id
       WHERE p.month_id = ?`
    )
    .all(req.params.monthId) as Array<any>;
  const cashRows = db
    .prepare(
      `SELECT h.id,
              -h.amount_cents as amount_cents,
              h.created_at,
              c.label as label,
              'paiement_espece' as category,
              'payee' as status,
              '' as note,
              'charge' as operation_group
       FROM cash_history h
       JOIN charges c ON c.id = h.charge_id
       WHERE h.month_id = ?`
    )
    .all(req.params.monthId) as Array<any>;
  const transferRows = db
    .prepare(
      `SELECT t.id,
              t.amount_cents,
              t.transfer_date as created_at,
              ('Transfert ' || f.name || ' -> ' || tt.name) as label,
              'transfert' as category,
              'effectue' as status,
              COALESCE(t.note, '') as note,
              'other' as operation_group
       FROM transfers t
       JOIN accounts f ON f.id = t.from_account_id
       JOIN accounts tt ON tt.id = t.to_account_id
       WHERE t.month_id = ?`
    )
    .all(req.params.monthId) as Array<any>;
  const adjustmentRows = db
    .prepare(
      `SELECT a.id,
              a.delta_cents as amount_cents,
              a.adjustment_date as created_at,
              ('Ajustement ' || acc.name) as label,
              'ajustement' as category,
              'effectue' as status,
              COALESCE(a.note, '') as note,
              'other' as operation_group
       FROM account_adjustments a
       JOIN accounts acc ON acc.id = a.account_id
       WHERE a.month_id = ?`
    )
    .all(req.params.monthId) as Array<any>;
  const rows = [...resourcesRows, ...chargePaymentsRows, ...cashRows, ...transferRows, ...adjustmentRows].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at))
  );
  res.json(rows);
});

const PORT = Number(process.env.PORT ?? 4000);
httpServer.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
