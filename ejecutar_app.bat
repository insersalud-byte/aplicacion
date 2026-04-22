@echo off
echo ============================================
echo    Inser Salud - Gestion de Equipos
echo ============================================
echo.
echo Abriendo aplicacion...
echo.
echo Si no se abre automaticamente, copiá esta direccion en tu navegador:
echo http://localhost:3000
echo.
echo Presioná Ctrl+C para cerrar
echo.

cd /d "%~dp0dist"
npx serve -l 3000
pause