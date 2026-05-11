import path from "node:path";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { ACCOUNT_NAMES } from "@budget/shared";

const dbPath = process.env.BUDGET_DB_PATH ?? path.resolve(process.cwd(), "budget.db");
console.log("[db] SQLite:", dbPath, "| cwd:", process.cwd());
export const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS months (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  month_id TEXT NOT NULL,
  name TEXT NOT NULL,
  balance_cents INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  month_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  expected_date TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS charges (
  id TEXT PRIMARY KEY,
  month_id TEXT NOT NULL,
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  account_id TEXT NOT NULL,
  expected_date TEXT NOT NULL,
  status TEXT NOT NULL,
  payment_mode TEXT,
  note TEXT,
  charge_type TEXT
);

CREATE TABLE IF NOT EXISTS charge_payments (
  id TEXT PRIMARY KEY,
  month_id TEXT NOT NULL,
  charge_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  payment_date TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS cash_history (
  id TEXT PRIMARY KEY,
  month_id TEXT NOT NULL,
  charge_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  month_id TEXT NOT NULL,
  from_account_id TEXT NOT NULL,
  to_account_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  transfer_date TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS account_adjustments (
  id TEXT PRIMARY KEY,
  month_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  previous_balance_cents INTEGER NOT NULL,
  new_balance_cents INTEGER NOT NULL,
  delta_cents INTEGER NOT NULL,
  adjustment_date TEXT NOT NULL,
  note TEXT
);
`);

function ensureColumn(table: string, column: string, sqlType: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
  }
}

ensureColumn("resources", "note", "TEXT");
ensureColumn("charges", "payment_mode", "TEXT");
ensureColumn("charges", "note", "TEXT");
ensureColumn("charges", "charge_type", "TEXT");

function migrateChargesNullableAccount() {
  const cols = db.prepare("PRAGMA table_info(charges)").all() as Array<{ name: string; notnull: number }>;
  const acc = cols.find((c) => c.name === "account_id");
  if (!acc || acc.notnull === 0) return;
  db.exec(`
    CREATE TABLE charges_mig (
      id TEXT PRIMARY KEY,
      month_id TEXT NOT NULL,
      label TEXT NOT NULL,
      category TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      paid_cents INTEGER NOT NULL DEFAULT 0,
      account_id TEXT,
      expected_date TEXT NOT NULL,
      status TEXT NOT NULL,
      payment_mode TEXT,
      note TEXT,
      charge_type TEXT
    );
    INSERT INTO charges_mig SELECT id, month_id, label, category, amount_cents, paid_cents, account_id, expected_date, status, payment_mode, note, charge_type FROM charges;
    DROP TABLE charges;
    ALTER TABLE charges_mig RENAME TO charges;
  `);
}

migrateChargesNullableAccount();

ensureColumn("charge_payments", "payment_mode", "TEXT");
ensureColumn("months", "opening_forecast_hors_epargne_cents", "INTEGER");

const monthCount = db.prepare("SELECT COUNT(*) as value FROM months").get() as { value: number };

if (monthCount.value === 0) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const monthId = randomUUID();
  db.prepare(
    "INSERT INTO months (id, label, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(monthId, `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`, start.toISOString(), end.toISOString(), new Date().toISOString());

  const insertAccount = db.prepare(
    "INSERT INTO accounts (id, month_id, name, balance_cents) VALUES (?, ?, ?, 0)"
  );
  for (const name of ACCOUNT_NAMES) {
    insertAccount.run(randomUUID(), monthId, name);
  }
}
