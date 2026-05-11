@echo off
chcp 65001 >nul
setlocal EnableExtensions

REM Va a la racine du depot (dossier ou se trouve ce fichier)
cd /d "%~dp0"

REM --- Chemin du SDK : par defaut Android Studio sur Windows ---
REM Si Android Studio affiche un autre chemin (Settings > Android SDK), decommentez et modifiez :
REM set "ANDROID_SDK_CUSTOM=C:\Users\hp\AppData\Local\Android\Sdk"

if defined ANDROID_SDK_CUSTOM (
  set "SDK=%ANDROID_SDK_CUSTOM%"
) else (
  set "SDK=%LOCALAPPDATA%\Android\Sdk"
)

if not exist "%SDK%\platform-tools" (
  echo.
  echo [ERREUR] SDK introuvable ou incomplet ici :
  echo   %SDK%
  echo Le sous-dossier "platform-tools" doit exister ^(installez "Android SDK Platform-Tools" dans Android Studio^).
  echo.
  echo Installez Android Studio : https://developer.android.com/studio
  echo Puis SDK Manager : cochez "Android SDK Platform-Tools".
  echo Ensuite, si le SDK n'est pas au chemin ci-dessus, editez build-apk.cmd et definissez ANDROID_SDK_CUSTOM.
  echo.
  pause
  exit /b 1
)

set "ANDROID_HOME=%SDK%"
set "ANDROID_SDK_ROOT=%SDK%"
echo ANDROID_HOME=%ANDROID_HOME%
echo.

call npm run apk:debug
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo Echec du build ^(code %ERR%^).
  pause
  exit /b %ERR%
)

echo.
echo APK genere sous :
echo   apps\web\android\app\build\outputs\apk\debug\app-debug.apk
echo.
pause
endlocal
exit /b 0
