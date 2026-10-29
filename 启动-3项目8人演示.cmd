@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
set "HUB_DEMO_EXE=%~dp0.runtime\electron.exe"
if not exist "%HUB_DEMO_EXE%" set "HUB_DEMO_EXE=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%HUB_DEMO_EXE%" (
  echo Please run npm ci first.
  pause
  exit /b 1
)
pushd "%~dp0"
"%HUB_DEMO_EXE%" . --demo-company
popd
endlocal
