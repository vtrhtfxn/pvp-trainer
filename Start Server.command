#!/bin/bash
# Double-click this to host PvP Trainer. Same as running `npm run server`, but it also
# installs dependencies the first time and keeps the window open if anything goes wrong.

cd "$(dirname "$0")" || exit 1

# A double-clicked .command gets a login shell but not always the PATH from a terminal,
# so add the usual places Node ends up.
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

fail() {
  echo ""
  echo "  $1"
  echo ""
  read -r -p "  Press Return to close."
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed. Get it from https://nodejs.org (the LTS button), then run this again."
fi

if [ ! -d node_modules ]; then
  echo "  First run — installing dependencies (this takes a minute)…"
  npm install || fail "npm install failed."
fi

echo "  Building…"
npm run build --silent || fail "Build failed. Run 'npm run build' in a terminal to see why."
npm run build:server --silent || fail "Server build failed."

echo ""
node dist-server/server.mjs
status=$?

echo ""
if [ $status -ne 0 ]; then
  echo "  Server exited with code $status."
else
  echo "  Server stopped."
fi
read -r -p "  Press Return to close."
