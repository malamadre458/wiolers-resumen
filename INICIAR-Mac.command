#!/bin/bash
# Doble clic (Mac) para abrir la app de resúmenes en tu ordenador. La primera vez: clic derecho → Abrir.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Falta Node.js. Descárgalo (versión LTS) en https://nodejs.org, instálalo y vuelve a abrir este archivo."
  open "https://nodejs.org"
  read -n 1 -s -r -p "Pulsa una tecla para cerrar…"; exit 1
fi
PORT=$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]'); PORT=${PORT:-3020}
( sleep 2; open "http://localhost:$PORT" ) &
echo "Deja esta ventana abierta mientras uses la app."
node server.js
