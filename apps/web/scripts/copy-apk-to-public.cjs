/**
 * Copie l'APK debug Gradle vers public/releases/ pour le prochain `vite build` (déploiement hosting).
 */
const fs = require("fs");
const path = require("path");

const webRoot = path.join(__dirname, "..");
const src = path.join(webRoot, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const destDir = path.join(webRoot, "public", "releases");
const dest = path.join(destDir, "budget-famille-ajoub.apk");

if (!fs.existsSync(src)) {
  console.error("APK introuvable. Lancez d'abord : npm run android:apk:debug");
  console.error("Chemin attendu :", src);
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log("APK copie vers", dest);
