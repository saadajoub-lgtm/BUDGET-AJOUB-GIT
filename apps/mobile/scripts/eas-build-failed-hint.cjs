/* eslint-disable no-console */
console.error(`
------------------------------------------------------------------
Le build EAS a echoue (souvent apres "Uploaded to EAS").

Causes frequentes :
  1) Quota Android du plan gratuit Expo epuise pour le mois.
     -> Ouvrez https://expo.dev (compte du projet) > Builds : lisez l'erreur exacte.
     -> Facturation / plan : https://expo.dev/settings/billing
     -> Sinon attendez le renouvellement mensuel indique par le CLI.

  2) Git absent (ENOENT) : installez Git for Windows, ou gardez EAS_NO_VCS=1.

  3) Build local sans quota cloud (machine avec Android SDK + Docker ou Studio) :
     https://docs.expo.dev/build-reference/local-builds/
------------------------------------------------------------------
`);
