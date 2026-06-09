@echo off
:: dev.cmd — run a node command with the **x64** Node.js in scope.
:: Why: native-sound-mixer ships an x64-only prebuilt. On Windows arm64
:: the active fnm-managed Node may be arm64 and can't load it. We
:: prepend the system x64 Node to PATH and tell fnm to use x64 for any
:: version lookup, then forward the rest of the command line.

:: Find an x64 Node and put it first in PATH
set "NODE_DIR="
if exist "C:\Program Files\nodejs\node.exe" set "NODE_DIR=C:\Program Files\nodejs"
if "%NODE_DIR%"=="" if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_DIR=C:\Program Files (x86)\nodejs"
if not "%NODE_DIR%"=="" set "PATH=%NODE_DIR%;%PATH%"

:: Force fnm to look up x64 versions if a version manager is active
set "FNM_ARCH=x64"

:: Run the rest of the command line
%*
