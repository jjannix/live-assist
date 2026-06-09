@echo off
:: Change to the directory of the script
cd /d %~dp0

:: Check for updates from the GitHub repository
echo Checking for updates from GitHub...
git pull origin main

:: Decide whether Voicemeeter is needed
:: (set AUDIO_BACKEND=voicemeeter in .env to force, or set NO_VM=1 to skip)
set "NEED_VM=0"
if /i "%AUDIO_BACKEND%"=="voicemeeter" set "NEED_VM=1"
if /i "%AUDIO_BACKEND%"=="auto" set "NEED_VM=1"
if "%NO_VM%"=="1" set "NEED_VM=0"

:: Start Voicemeeter only if needed
if "%NEED_VM%"=="1" (
    if exist "C:\Program Files (x86)\VB\Voicemeeter\Voicemeeterpro.exe" (
        echo Starting Voicemeeter...
        start "" "C:\Program Files (x86)\VB\Voicemeeter\Voicemeeterpro.exe"
        timeout /t 5 /nobreak >nul
    ) else (
        echo Voicemeeter not found at default path — backend will fall back to native (native-sound-mixer) if AUDIO_BACKEND=auto
    )
) else (
    echo Skipping Voicemeeter (AUDIO_BACKEND=%AUDIO_BACKEND%)
)

:: Add OBS to the PATH environment variable
set "PATH=C:\Program Files\obs-studio\bin\64bit;%PATH%"

:: Check if OBS Studio is installed correctly
if exist "C:\Program Files\obs-studio\bin\64bit\obs64.exe" (
    :: Check for localization files
    if exist "C:\Program Files\obs-studio\data\obs-studio\locale\en-US.ini" (
        echo Starting OBS Studio...
        start "" /b "cmd.exe" /c "cd /d C:\Program Files\obs-studio\bin\64bit && obs64.exe"
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

:: Pick the right Node.js: must be **x64** because the native-sound-mixer
:: prebuilt is x64-only (Windows arm64 emulates x64 via Prism; fnm's
:: arm64 build cannot load x64 native addons). Search a few common
:: locations and refuse to start if we can only find arm64.
set "NODE_EXE="
if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if "%NODE_EXE%"=="" if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"
if "%NODE_EXE%"=="" (
    for /f "delims=" %%I in ('where node 2^>nul') do (
        if "%NODE_EXE%"=="" set "NODE_EXE=%%I"
    )
)
if "%NODE_EXE%"=="" (
    echo ERROR: Node.js not found. Install it from https://nodejs.org/
    pause
    exit /b
)

echo Using Node: %NODE_EXE%
"%NODE_EXE%" -e "console.log('  arch=' + process.arch + ' platform=' + process.platform)"
"%NODE_EXE%" -e "if (process.arch !== 'x64' && process.arch !== 'ia32') { console.error('\n  ERROR: native-sound-mixer requires an x64 Node.js. Your active node is ' + process.arch + '.\n  Install x64 from https://nodejs.org/ or run:  fnm uninstall 24.16.0 ^&^& fnm install 24 --arch x64'); process.exit(1) }"

:: Start the Node.js server
echo Starting Node.js server...
start "" /b "cmd.exe" /c "\"%NODE_EXE%\" server.js"

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
