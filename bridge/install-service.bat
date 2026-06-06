@echo off
echo TWV Tally Bridge v1.3.3 — Install as Windows Service
echo ======================================================
echo.

:: Check for Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not in PATH.
    echo Download from https://nodejs.org (LTS version)
    pause
    exit /b 1
)

:: Check config.json exists
if not exist "config.json" (
    echo config.json not found.
    echo Copying config.example.json to config.json — fill in your values before running this again.
    copy config.example.json config.json
    echo.
    echo Open config.json in Notepad and set:
    echo   agent_token       — from Vercel env var TALLY_AGENT_TOKEN
    echo   tally_host/port   — Tally Prime XML server (usually localhost:9000)
    echo   tally_target_company — exact company name as it appears in Tally
    echo.
    notepad config.json
    echo.
    echo Re-run this script after saving config.json.
    pause
    exit /b 1
)

echo Installing Windows Service (auto-starts with Windows)...
node dist\install-service.js

echo.
echo Done. Check status at http://localhost:7788
pause
