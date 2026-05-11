@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ATTENTION : l'URL "saadajoub-lqtm" ^(avec Q^) donne souvent une page 404 : ce depot n'existe pas.
echo Le depot avec le code et le workflow a jour est "saadajoub-lgtm" ^(avec G^).
echo Pour ouvrir les Actions : double-clic sur ouvrir-github-actions.cmd
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo Git introuvable dans le PATH. Utilisez "C:\Program Files\Git\bin\git.exe" ou installez Git for Windows.
  pause
  exit /b 1
)

git remote remove lqtm 2>nul
git remote add lqtm https://github.com/saadajoub-lqtm/BUDGET-AJOUB-GIT.git

echo.
echo Poussage vers saadajoub-lqtm/BUDGET-AJOUB-GIT ^(main + principal^)...
echo Si Git demande une connexion, utilisez le compte qui POSSEDE ce depot.
echo.

git push lqtm main
if errorlevel 1 goto :fail
git push lqtm main:principal
if errorlevel 1 goto :fail

echo.
echo OK. Sur GitHub ^(lqtm^) : Actions ^> relancez le workflow Capacitor Android APK.
echo.
pause
exit /b 0

:fail
echo.
echo ------------------------------------------------------------------
echo ECHEC. Souvent : "Repository not found" = mauvais compte / mauvais jeton.
echo  - Panneau Windows ^> Gestionnaire d'identification ^> supprimez github.com
echo  - Relancez ce script et reconnectez-vous avec le compte lqtm
echo.
echo OU mettez a jour le workflow a la main sur GitHub ^(branche principal^) :
echo   https://github.com/saadajoub-lqtm/BUDGET-AJOUB-GIT/edit/principal/.github/workflows/capacitor-android-apk.yml
echo Collez le contenu du fichier local :
echo   %CD%\.github\workflows\capacitor-android-apk.yml
echo ------------------------------------------------------------------
pause
exit /b 1
