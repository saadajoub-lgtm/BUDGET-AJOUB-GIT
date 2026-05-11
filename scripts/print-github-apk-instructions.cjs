/* eslint-disable no-console */
console.log(`
APK Android (Capacitor) via GitHub Actions — sans Expo

ATTENTION : verifiez l'URL GitHub (compte + nom du depot). Une seule lettre change tout
  (ex. saadajoub-lgtm vs saadajoub-lqtm). Les correctifs CI doivent etre pousses sur le
  MEME depot que celui ou vous ouvrez l'onglet Actions.

0) Git installe ? Sinon : https://git-scm.com/download/win
   Puis : npm run github:init   (ou double-clic sur init-git-for-github.cmd)

1) Creez un depot VIDE sur https://github.com/new (sans README si vous poussez un existant).

2) Dans ce dossier (racine du projet) :
   git remote add origin https://github.com/VOTRE_USER/VOTRE_REPO.git
   git push -u origin main

3) Sur GitHub : Actions > workflow "Capacitor Android APK (debug)" > Run workflow > Run workflow.

4) Job vert : ouvrez le run > Artifacts > "budget-famille-ajoub-debug" (app-debug.apk).

En local (Android Studio / SDK) : npm run apk:debug
`);
