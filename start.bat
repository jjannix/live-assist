@echo off
:: ============================================================
::  jnk Live Assist - launcher
::
::  Starts Voicemeeter (if installed), OBS Studio, and the
::  Node.js server, then opens the controller in your browser.
::
::  Run:   .\start.bat
::  Stop:  close the window titled "jnk Live Assist - Server"
::         (or press Ctrl+C inside it).
:: ============================================================

cd /d %~dp0

:: -- 1. Update from GitHub --------------------------------------
echo Checking for updates from GitHub...
git pull origin main >nul 2>&1
if errorlevel 1 echo   Could not update - continuing with current version.

:: -- 2. Voicemeeter - start if installed, else native backend --
::       No env-var guessing: if the exe is on disk, launch it.
::       If it isn't, the app's 'auto' backend falls back to the
::       native per-app mixer automatically.
set "VM_EXE="
if exist "C:\Program Files (x86)\VB\Voicemeeter\VoicemeeterPro.exe" if not defined VM_EXE set "VM_EXE=C:\Program Files (x86)\VB\Voicemeeter\VoicemeeterPro.exe"
if exist "C:\Program Files\VB\Voicemeeter\VoicemeeterPro.exe" if not defined VM_EXE set "VM_EXE=C:\Program Files\VB\Voicemeeter\VoicemeeterPro.exe"
if exist "C:\Program Files (x86)\VB\Voicemeeter\voicemeeter.exe" if not defined VM_EXE set "VM_EXE=C:\Program Files (x86)\VB\Voicemeeter\voicemeeter.exe"
if exist "C:\Program Files\VB\Voicemeeter\voicemeeter.exe" if not defined VM_EXE set "VM_EXE=C:\Program Files\VB\Voicemeeter\voicemeeter.exe"
if defined VM_EXE goto :vm_found
echo Voicemeeter not found - using native audio backend.
goto :start_obs
:vm_found
echo Starting Voicemeeter...
start "" "%VM_EXE%"
timeout /t 4 /nobreak >nul

:start_obs
:: -- 3. OBS Studio ----------------------------------------------
::       OBS resolves its data paths (locale/, plugins/) relative to
::       its working directory, not the exe location. Launching it
::       from anywhere else fails with "Failed to find locale/en-US.ini",
::       so we set its startup dir to its own bin folder via /d.
set "OBS_DIR=C:\Program Files\obs-studio\bin\64bit"
set "OBS_EXE=%OBS_DIR%\obs64.exe"
if exist "%OBS_EXE%" goto :obs_ok
echo ERROR: OBS Studio not found at "%OBS_EXE%".
echo        Install it from https://obsproject.com/download
echo        Then re-run this script.
pause
exit /b 1
:obs_ok
echo Starting OBS Studio...
start "" /d "%OBS_DIR%" "%OBS_EXE%"
timeout /t 4 /nobreak >nul

:: -- 4. Find an x64 Node.js -------------------------------------
::       native-sound-mixer ships an x64-only prebuilt; an arm64
::       Node (e.g. fnm's arm64 build) cannot load it.
set "NODE_EXE="
if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"
if not defined NODE_EXE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if defined NODE_EXE goto :node_ok
echo ERROR: Node.js not found. Install it from https://nodejs.org/
pause
exit /b 1
:node_ok
echo Using Node: %NODE_EXE%
"%NODE_EXE%" -e "if(process.arch!=='x64'){console.error('  ERROR: native-sound-mixer needs an x64 Node.js. Yours is '+process.arch+'.');console.error('  Install the x64 build from https://nodejs.org/');process.exit(1)}"
if not errorlevel 1 goto :arch_ok
echo.
pause
exit /b 1
:arch_ok

:: -- 5. Server + browser ----------------------------------------
echo.
echo ============================================================
echo   jnk Live Assist is starting.
echo   Controller:  http://localhost:3000
echo   Settings:    http://localhost:3000/config.html
echo   The server runs in its own window - close it to stop.
echo ============================================================
echo.
echo Starting server...
start "jnk Live Assist - Server" cmd /k ""%NODE_EXE%" server.js"

:: Give the server a moment to bind to port 3000, then open the
:: controller in the system default browser.
timeout /t 3 /nobreak >nul
echo Opening controller in your browser...
start "" "http://localhost:3000"

echo.
echo Done. You can close this window.
pause
