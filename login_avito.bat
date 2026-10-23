@echo off
chcp 65001 >nul
echo Запуск авторизации Avito...
if exist "%~dp0.venv\Scripts\python.exe" (
    "%~dp0.venv\Scripts\python.exe" "%~dp0login_avito.py"
) else (
    python "%~dp0login_avito.py"
)
pause
