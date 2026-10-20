@echo off
chcp 65001 >nul
title Resumen de Discord - AXFL
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto :instalar_node
echo.
echo  Abriendo la app en http://localhost:3020
echo  Deja esta ventana abierta mientras la uses.
echo.
start "" /min cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3020"
node server.js
echo.
echo  La app se ha cerrado.
pause
exit /b
:instalar_node
echo.
echo  Falta Node.js. Instalandolo, acepta los permisos si Windows pregunta...
echo.
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if errorlevel 1 (
  echo  No se pudo instalar solo. Se abre la web de Node.js: descarga la version LTS e instalala.
  start "" https://nodejs.org
)
echo.
echo  Cuando termine, CIERRA esta ventana y vuelve a hacer doble clic en INICIAR.
pause
exit /b
