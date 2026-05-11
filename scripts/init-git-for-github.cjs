/**
 * Initialise le depot Git (si absent), ajoute les fichiers, affiche le statut et les etapes GitHub Actions.
 */
const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function hasGit() {
  const r = spawnSync("git", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  return r.status === 0;
}

function runGit(args) {
  execSync(["git", ...args].join(" "), { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
}

if (!hasGit()) {
  console.error("\nGit est introuvable. Installez Git for Windows : https://git-scm.com/download/win\n");
  process.exit(1);
}

if (!fs.existsSync(path.join(root, ".git"))) {
  console.log("Initialisation du depot (branche main)...\n");
  runGit(["init", "-b", "main"]);
} else {
  console.log("Depot Git deja present (.git).\n");
}

console.log("git add -A && git status\n");
runGit(["add", "-A"]);
runGit(["status", "-sb"]);

console.log(`
------------------------------------------------------------------
Etape suivante : creez un depot VIDE sur https://github.com/new

Puis dans ce dossier :
  git remote add origin https://github.com/VOTRE_USER/VOTRE_REPO.git
  git commit -m "Initial commit"
  git push -u origin main

Sur GitHub : Actions > "Capacitor Android APK (debug)" > Run workflow

Job termine : Artifacts > budget-famille-ajoub-debug (app-debug.apk)
------------------------------------------------------------------
`);
