@echo off
setlocal
cd /d "%~dp0"

REM Load .env file
if exist .env (
    for /f "usebackq delims=" %%a in (.env) do (
        for /f "tokens=1,* delims==" %%b in ("%%a") do (
            if not "%%b"=="" if not "%%b"=="" set "%%b=%%c"
        )
    )
)

REM Check required env vars
if "%DISCORD_TOKEN%"=="" (
    echo Error: DISCORD_TOKEN is not set.
    echo Copy .env.example to .env and add your bot token.
    exit /b 1
)

echo Starting Discord MCP Server + Gemini Bot...
npm start
