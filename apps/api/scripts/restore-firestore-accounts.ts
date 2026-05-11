import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const REQUIRED_ACCOUNTS = [
  "BANK OF AFRICA",
  "SAHAM BANK",
  "CDM MELANIE",
  "CDM SAAD 1",
  "CDM SAAD 2",
  "ESPECE",
  "EPARGNE"
];

const args = process.argv.slice(2);
const budgetArg = args.find((a) => a.startsWith("--budget="));
const confirmArg = args.find((a) => a.startsWith("--confirm="));
const projectArg = args.find((a) => a.startsWith("--project="));
const execute = args.includes("--execute");

const budgetId = budgetArg?.split("=")[1] || process.env.FIREBASE_BUDGET_ID || "default-budget";
const confirmToken = confirmArg?.split("=")[1] || "";

if (!confirmToken || confirmToken !== "RESTORE_ACCOUNTS_ONLY") {
  console.error("[restore-accounts] Confirmation invalide.");
  console.error("[restore-accounts] Requis: --confirm=RESTORE_ACCOUNTS_ONLY");
  process.exit(1);
}

function normalize(v: string) {
  return String(v ?? "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function readProjectIdFromFirebaserc() {
  try {
    const p = path.resolve(process.cwd(), ".firebaserc");
    if (!fs.existsSync(p)) return "";
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return String(raw?.projects?.default ?? "");
  } catch {
    return "";
  }
}

const projectId =
  projectArg?.split("=")[1] ||
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  readProjectIdFromFirebaserc() ||
  "budget-famille-ajoub";

async function run() {
  const adminApp = await import("firebase-admin/app");
  const adminFirestore = await import("firebase-admin/firestore");

  if (!adminApp.getApps().length) {
    const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
      adminApp.initializeApp({ credential: adminApp.cert(serviceAccount), projectId });
    } else {
      adminApp.initializeApp({ credential: adminApp.applicationDefault(), projectId });
    }
  }

  const db = adminFirestore.getFirestore();
  const rootRef = db.collection("budgets").doc(budgetId);
  const accountsSnap = await rootRef.collection("accounts").get();
  const existing = new Map<string, any>();
  for (const d of accountsSnap.docs) {
    const row = d.data() as any;
    existing.set(normalize(String(row.name ?? "")), { id: d.id, ...row });
  }

  const toCreate = REQUIRED_ACCOUNTS.filter((name) => !existing.has(normalize(name)));

  console.log(`[restore-accounts] Budget: ${budgetId}`);
  console.log(`[restore-accounts] Project: ${projectId}`);
  console.log(`[restore-accounts] Mode: ${execute ? "EXECUTION REELLE" : "DRY-RUN"}`);
  console.log(`[restore-accounts] Comptes existants: ${accountsSnap.size}`);
  console.log(`[restore-accounts] Comptes a creer: ${toCreate.join(", ") || "aucun"}`);

  if (!execute) return;

  for (const name of toCreate) {
    const id = crypto.randomUUID();
    await rootRef.collection("accounts").doc(id).set({
      id,
      month_id: "global",
      name,
      balance_cents: 0,
      updated_at: new Date().toISOString()
    });
  }

  console.log("[restore-accounts] Terminé.");
}

run().catch((err) => {
  console.error("[restore-accounts] Echec", err);
  process.exit(1);
});

