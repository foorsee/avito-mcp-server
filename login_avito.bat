@echo off
chcp 65001 >nul
echo Запуск авторизации Avito...
node "%~dp0login_avito.js"
pause
