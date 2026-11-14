#!/usr/bin/env bash

set -euo pipefail

DATA_DIR="${PAPERLOOM_DATA_DIR:-/data/paperloom}"
mkdir -p "${DATA_DIR}"

# The cookie secret is stored with the add-on's persistent data so it
# survives restarts and upgrades. This avoids a default secret that would
# make session cookies forgeable.
SECRET_FILE="${DATA_DIR}/cookie_secret"
if [ ! -s "${SECRET_FILE}" ]; then
    if [ -n "${PAPERLOOM_COOKIE_SECRET:-}" ]; then
        printf '%s' "${PAPERLOOM_COOKIE_SECRET}" > "${SECRET_FILE}"
    else
        od -An -N64 -tx1 /dev/urandom | tr -d ' \n' > "${SECRET_FILE}"
    fi
    chmod 600 "${SECRET_FILE}"
fi

export PAPERLOOM_COOKIE_SECRET="$(cat "${SECRET_FILE}")"

cd /app/server
exec node --enable-source-maps dist/index.js
