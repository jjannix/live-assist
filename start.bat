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

:: Add OBS to the PATH environment variable
set "PATH=C:\Program Files\obs-studio\bin\64bit;%PATH%"

:: Check if OBS Studio is installed correctly
if exist "C:\Program Files\obs-studio\bin\64bit\obs64.exe" (
    :: Check for localization files
    if exist "C:\Program Files\obs-studio\data\obs-studio\locale\en-US.ini" (
        echo Starting OBS Studio...
        start "" "cmd.exe" /c "cd /d C:\Program Files\obs-studio\bin\64bit && obs64.exe"
    ) else (
        echo ERROR: OBS Studio localization files not found.
        pause
        exit /b
    )
) else (
    echo ERROR: OBS Studio not found in the specified path.
    pause
    exit /b
)

:: Wait for a few seconds to ensure OBS starts properly
timeout /t 5 /nobreak >nul

:: Start the Node.js server
echo Starting Node.js server...
start "" "cmd.exe" /k "node server.js"

:: Wait for a few seconds to ensure the server starts properly
timeout /t 5 /nobreak >nul

:: Open Firefox on localhost:3000
if exist "C:\Program Files\Mozilla Firefox\firefox.exe" (
    echo Opening Firefox...
    start "" "C:\Program Files\Mozilla Firefox\firefox.exe" "http://localhost:3000"
) else (
    echo ERROR: Firefox not found in the specified path.
    pause
    exit /b
)

echo Environment setup complete.
pause
