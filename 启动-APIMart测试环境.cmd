@echo off
setlocal
set "APP_DIR=%~dp0"
set "RUNTIME_DIR=%APP_DIR%.runtime"
set "ELECTRON_EXE=%RUNTIME_DIR%\electron.exe"
set "CACHE_ZIP=%APP_DIR%..\desktop-cache\electron-v43.1.1-win32-x64.zip"
set "ELECTRON_RUN_AS_NODE="
rem Isolated APIMart test environment: its own project database and device
rem settings (model keys) under .runtime\apimart-test, never touching the
rem normal workbench data. .runtime is git-ignored.
set "AIDESIGNHUB_DATA_DIR=%APP_DIR%.runtime\apimart-test"

if not exist "%ELECTRON_EXE%" if exist "%APP_DIR%node_modules\electron\dist\electron.exe" set "ELECTRON_EXE=%APP_DIR%node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON_EXE%" (
  if not exist "%CACHE_ZIP%" (
    echo Run npm ci in the project directory to install Electron, then run npm start.
    pause
    exit /b 1
  )
  echo Preparing the local prototype runtime. This only runs once...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%CACHE_ZIP%' -DestinationPath '%RUNTIME_DIR%' -Force"
  if errorlevel 1 (
    echo Failed to prepare the local runtime.
    pause
    exit /b 1
  )
)

pushd "%APP_DIR%"
"%ELECTRON_EXE%" . %*
popd
endlocal
