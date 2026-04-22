@echo off
echo ========================================
echo    Inser Salud - Servidor Web
echo ========================================
echo.
echo Abriendo navegador...
start http://localhost:5173
echo.
echo Ejecutando servidor...
cd /d "%~dp0InserSaludWeb"
npm run dev
pause