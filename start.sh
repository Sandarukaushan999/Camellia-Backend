#!/usr/bin/env sh
set -eu

cd backend

if [ ! -d node_modules ]; then
  npm install --omit=dev
fi

exec npm run start
