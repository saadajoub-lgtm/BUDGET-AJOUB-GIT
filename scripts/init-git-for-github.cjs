/**
 * Initialise le depot Git (si absent), ajoute les fichiers, affiche le statut et les etapes GitHub Actions.
 * Retire un remote "origin" invalide (URL d'exemple copiee-collée).
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function resolveGit() {
  const fromEnv = String(process.env.GIT_EXE || "").trim();
  const candidates = [
    fromEnv || null,
    "git",
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\bin\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\bin\\git.exe"
  ].filter(Boolean);

  for (const g of candidates) {
    const r = spawnSync(g, ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
    if (r.status === 0) return g;
  }
  return null;
}

function runGit(git, args) {
  const r = spawnSync(git, args, { cwd: root, stdio: "inherit", encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function getOriginUrl(git) {
  const r = spawnSync(git, ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) return "";
  return String(r.stdout || "").trim();
}

function removeOriginIfPlaceholder(git) {
  const url = getOriginUrl(git);
  if (!url) return;
  const bad =
    url.includes("VOTRE_USER") ||
    url.includes("VOTRE_REPO") ||
    url.includes("example.com");
  if (!bad) return;
  console.warn("\n[!] Remote origin invalide (URL d'exemple) :", url);
  console.warn("    Suppression de origin. Ajoutez votre vrai depot avec : git remote add origin <URL>\n");
  runGit(git, ["remote", "remove", "origin"]);
}

const git = resolveGit();
if (!git) {
  console.error("\nGit est introuvable. Installez Git for Windows : https://git-scm.com/download/win\n");
  process.exit(1);
}

if (!fs.existsSync(path.join(root, ".git"))) {
  console.log("Initialisation du depot (branche main)...\n");
  runGit(git, ["init", "-b", "main"]);
} else {
  console.log("Depot Git deja present (.git).\n");
  removeOriginIfPlaceholder(git);
}

console.log("git add -A && git status\n");
runGit(git, ["add", "-A"]);
runGit(git, ["status", "-sb"]);

console.log(`
------------------------------------------------------------------
Etape suivante : creez un depot VIDE sur https://github.com/new

Puis dans ce dossier (remplacez par VOTRE URL reelle, pas VOTRE_USER) :
  git remote add origin https://github.com/<votre-compte>/<nom-du-depot>.git
  git commit -m "Initial commit"     (si des fichiers sont encore non commités)
  git push -u origin main

Sur GitHub : Actions > "Capacitor Android APK (debug)" > Run workflow

Job termine : Artifacts > budget-famille-ajoub-debug (app-debug.apk)
------------------------------------------------------------------
`);
