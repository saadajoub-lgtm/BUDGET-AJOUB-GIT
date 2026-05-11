import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

type AnyRow = Record<string, unknown>;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const outArg = args.find((a) => a.startsWith("--out="));
const budgetArg = args.find((a) => a.startsWith("--budget="));
const outFile = outArg ? outArg.split("=")[1] : path.resolve(process.cwd(), "migration-firestore-backup.json");
const budgetId = budgetArg ? budgetArg.split("=")[1] : process.env.FIREBASE_BUDGET_ID ?? "default-budget";

const dbPath = process.env.BUDGET_DB_PATH ?? path.resolve(process.cwd(), "budget.db");
const db = new Database(dbPath, { readonly: true });

function rows(sql: string, ...params: unknown[]) {
  return db.prepare(sql).all(...params) as AnyRow[];
}

function dedupe<T extends AnyRow>(items: T[], keyBuilder: (item: T) => string) {
  const out = new Map<string, T>();
  for (const item of items) out.set(keyBuilder(item), item);
  return Array.from(out.values());
}

const payload = {
  budgetId,
  exportedAt: new Date().toISOString(),
  months: dedupe(rows("SELECT * FROM months ORDER BY starts_at ASC"), (m) => String((m.id ?? m.label) as string)),
  accounts: dedupe(rows("SELECT * FROM accounts"), (a) => String((a.id ?? `${a.month_id}:${a.name}`) as string)),
  resources: dedupe(rows("SELECT * FROM resources"), (r) => String((r.id ?? `${r.month_id}:${r.type}:${r.expected_date}:${r.amount_cents}`) as string)),
  charges: dedupe(rows("SELECT * FROM charges"), (c) => String((c.id ?? `${c.month_id}:${c.label}:${c.expected_date}:${c.amount_cents}`) as string)),
  transfers: dedupe(rows("SELECT * FROM transfers"), (t) => String((t.id ?? `${t.month_id}:${t.from_account_id}:${t.to_account_id}:${t.transfer_date}:${t.amount_cents}`) as string)),
  histories: dedupe([
    ...rows("SELECT * FROM charge_payments"),
    ...rows("SELECT * FROM cash_history"),
    ...rows("SELECT * FROM account_adjustments")
  ], (h) => String((h.id ?? JSON.stringify(h)) as string)),
  categories: dedupe(rows("SELECT DISTINCT category FROM charges WHERE category IS NOT NULL AND category != ''"), (c) => String(c.category)),
  labels: dedupe(rows("SELECT DISTINCT label FROM charges WHERE label IS NOT NULL AND label != ''"), (l) => String(l.label))
};

fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");
console.log(`[migration] Backup JSON écrit: ${outFile}`);
console.log(
  `[migration] Résumé: months=${payload.months.length}, accounts=${payload.accounts.length}, resources=${payload.resources.length}, charges=${payload.charges.length}, transfers=${payload.transfers.length}, histories=${payload.histories.length}`
);

if (dryRun) {
  console.log("[migration] Dry-run activé: aucune écriture Firestore.");
  process.exit(0);
}

async function uploadToFirestore() {
  let admin: any;
  try {
    admin = await import("firebase-admin");
  } catch {
    console.error("[migration] firebase-admin introuvable. Installez-le ou relancez avec --dry-run.");
    process.exit(1);
  }

  if (!admin.apps.length) {
    const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
    }
  }

  const firestore = admin.getFirestore();
  const rootRef = firestore.collection("budgets").doc(budgetId);
  await rootRef.set(
    {
      updatedAt: new Date().toISOString(),
      migratedFrom: "sqlite"
    },
    { merge: true }
  );

  const batchWrite = async (collectionName: string, data: AnyRow[]) => {
    for (const row of data) {
      const id = String((row as any).id ?? `${collectionName}-${Math.random().toString(36).slice(2)}`);
      await rootRef.collection(collectionName).doc(id).set(row, { merge: true });
    }
  };

  await batchWrite("accounts", payload.accounts);
  await batchWrite("resources", payload.resources);
  await batchWrite("charges", payload.charges);
  await batchWrite("transfers", payload.transfers);
  await batchWrite("histories", payload.histories);
  await batchWrite("categories", payload.categories);
  await batchWrite("labels", payload.labels);
  await batchWrite("members", []);

  console.log("[migration] Import Firestore terminé.");
}

uploadToFirestore().catch((err) => {
  console.error("[migration] Echec import Firestore", err);
  process.exit(1);
});
