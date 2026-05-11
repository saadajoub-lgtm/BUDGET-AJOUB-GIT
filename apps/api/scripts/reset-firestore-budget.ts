import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

type AnyDoc = Record<string, unknown>;

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
const projectIdFromArg = projectArg?.split("=")[1];

function readProjectIdFromFirebaserc() {
  try {
    const firebasercPath = path.resolve(process.cwd(), ".firebaserc");
    if (!fs.existsSync(firebasercPath)) return "";
    const raw = JSON.parse(fs.readFileSync(firebasercPath, "utf8"));
    return String(raw?.projects?.default ?? "");
  } catch {
    return "";
  }
}

const projectId =
  projectIdFromArg ||
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  readProjectIdFromFirebaserc() ||
  "budget-famille-ajoub";

if (!confirmToken || confirmToken !== "RESET_BUDGET_ONLINE_DATA") {
  console.error("[reset] Confirmation invalide.");
  console.error('[reset] Requis: --confirm=RESET_BUDGET_ONLINE_DATA');
  process.exit(1);
}

async function getAdmin() {
  let adminApp: any;
  let adminFirestore: any;
  try {
    adminApp = await import("firebase-admin/app");
    adminFirestore = await import("firebase-admin/firestore");
  } catch {
    console.error("[reset] firebase-admin introuvable. Installez-le: npm i -w apps/api firebase-admin");
    process.exit(1);
  }

  if (!adminApp.getApps().length) {
    const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
      adminApp.initializeApp({ credential: adminApp.cert(serviceAccount), projectId });
    } else {
      adminApp.initializeApp({ credential: adminApp.applicationDefault(), projectId });
    }
  }
  return { adminApp, adminFirestore };
}

async function listCollection(rootRef: any, collectionName: string) {
  const snap = await rootRef.collection(collectionName).get();
  return snap.docs;
}

async function deleteCollection(rootRef: any, collectionName: string, doWrite: boolean) {
  const docs = await listCollection(rootRef, collectionName);
  if (!doWrite) return docs.length;
  for (const d of docs) await d.ref.delete();
  return docs.length;
}

async function run() {
  const { adminFirestore } = await getAdmin();
  const firestore = adminFirestore.getFirestore();
  const rootRef = firestore.collection("budgets").doc(budgetId);
  const now = new Date();
  const monthLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const monthStartsAt = `${monthLabel}-01T00:00:00.000Z`;
  const doWrite = execute;

  console.log(`[reset] Budget cible: ${budgetId}`);
  console.log(`[reset] Project cible: ${projectId}`);
  console.log(`[reset] Mode: ${doWrite ? "EXECUTION REELLE" : "DRY-RUN (aucune ecriture)"}`);

  const collectionsToClear = [
    "resources",
    "charges",
    "transfers",
    "histories",
    "charge_payments",
    "cash_history",
    "account_adjustments",
    "months",
    "payment_debug_logs"
  ];

  const summary: Record<string, number> = {};
  for (const c of collectionsToClear) {
    const count = await deleteCollection(rootRef, c, doWrite);
    summary[c] = count;
  }

  const accountsSnap = await rootRef.collection("accounts").get();
  summary.accounts_existing = accountsSnap.size;

  if (doWrite) {
    for (const d of accountsSnap.docs) {
      await d.ref.delete();
    }

    for (const name of REQUIRED_ACCOUNTS) {
      const id = crypto.randomUUID();
      await rootRef.collection("accounts").doc(id).set({
        id,
        month_id: "global",
        name,
        balance_cents: 0,
        updated_at: new Date().toISOString()
      } satisfies AnyDoc);
    }

    const monthId = crypto.randomUUID();
    await rootRef.collection("months").doc(monthId).set({
      id: monthId,
      label: monthLabel,
      starts_at: monthStartsAt,
      ends_at: monthStartsAt,
      created_at: new Date().toISOString()
    } satisfies AnyDoc);

    await rootRef.set(
      {
        updatedAt: new Date().toISOString(),
        resetAt: new Date().toISOString(),
        resetBy: "admin-script"
      },
      { merge: true }
    );
  }

  console.log("[reset] Resume:");
  for (const [k, v] of Object.entries(summary)) {
    console.log(`  - ${k}: ${v}`);
  }
  console.log(`[reset] Comptes conserves/recrees: ${REQUIRED_ACCOUNTS.join(", ")}`);
  console.log(`[reset] Mois courant conserve/recree: ${monthLabel}`);
  console.log(`[reset] Firebase Auth NON touche.`);
}

run().catch((err) => {
  console.error("[reset] Echec", err);
  process.exit(1);
});

