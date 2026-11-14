@echo off
title A.R.I.S Discord Bot (Local Host)
cd /d "%~dp0"
echo ===================================================
echo   A.R.I.S Discord Bot
echo ===================================================
if not exist "node_modules" (
    echo [1/2] Installing dependencies via npm.cmd...
    call npm.cmd install
)
echo [2/2] Starting A.R.I.S Bot with IPv4 DNS priority...
node --dns-result-order=ipv4first src/index.js
pause
