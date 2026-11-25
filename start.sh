#!/usr/bin/env bash
# Schiffe versenken – mit einem Befehl holen, installieren, starten und im Browser öffnen (macOS/Linux):
#   curl -fsSL https://raw.githubusercontent.com/WTK1611/schiffe-versenken/main/start.sh | bash
# Erneut ausführen = auf den neuesten Stand bringen und neu starten.
set -euo pipefail

DIR="${SCHIFFE_DIR:-$HOME/schiffe-versenken}"
REPO="https://github.com/WTK1611/schiffe-versenken.git"
PORT="${PORT:-3000}"
say() { printf '\033[1;35m⚓ %s\033[0m\n' "$*"; }

# Node.js vorhanden? Sonst per Homebrew installieren (oder zur Download-Seite schicken)
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    say "Node.js fehlt – installiere es mit Homebrew …"
    brew install node
  else
    say "Node.js fehlt. Bitte die LTS-Version von https://nodejs.org installieren und den Befehl nochmal ausführen."
    if command -v open >/dev/null 2>&1; then open "https://nodejs.org/de/download"; fi
    exit 1
  fi
fi

# Spiel holen oder aktualisieren
if [ -d "$DIR/.git" ]; then
  say "Aktualisiere $DIR …"
  git -C "$DIR" pull --ff-only -q || say "Aktualisieren übersprungen (lokale Änderungen) – starte den vorhandenen Stand."
else
  say "Lade das Spiel nach $DIR …"
  git clone -q "$REPO" "$DIR"
fi
cd "$DIR"

say "Installiere Abhängigkeiten …"
npm install --silent --no-audit --no-fund

# Läuft schon eine ältere Instanz auf dem Port? Dann beenden.
if command -v lsof >/dev/null 2>&1; then
  OLD="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$OLD" ]; then say "Beende alte Instanz auf Port $PORT …"; kill $OLD 2>/dev/null || true; sleep 1; fi
fi

URL="http://localhost:$PORT"
( sleep 2
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1; fi ) &

say "Start auf $URL – Handys und Fernseher nutzen die WLAN-Adresse unten. Beenden mit Ctrl+C."
PORT="$PORT" exec npm start
