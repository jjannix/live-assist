@echo off
:: Change to the directory of the script
cd /d %~dp0

:: Check for updates from the GitHub repository
echo Checking for updates from GitHub...
git pull origin main

:: Start Voicemeeter
echo Starting Voicemeeter...
start "" "C:\Program Files (x86)\VB\Voicemeeter\Voicemeeter.exe"

:: Wait for a few seconds to ensure Voicemeeter starts properly
timeout /t 5 /nobreak >nul

:: Start OBS Studio
echo Starting OBS Studio...
start "" "C:\Program Files\obs-studio\bin\64bit\obs64.exe"

:: Wait for a few seconds to ensure OBS starts properly
timeout /t 5 /nobreak >nul

:: Start the Node.js server
echo Starting Node.js server...
start "" "cmd.exe" /k "node server.js"

:: Wait for a few seconds to ensure the server starts properly
timeout /t 5 /nobreak >nul

:: Open Firefox on localhost:3000
echo Opening Firefox...
start "" "C:\Program Files\Mozilla Firefox\firefox.exe" "http://localhost:3000"

echo Environment setup complete.
pause
