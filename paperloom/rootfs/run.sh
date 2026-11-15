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

# The bot's token is set in the management interface, so that each gallery
# can have its own bot. The poll interval is a server setting.
if [ -n "${PAPERLOOM_TELEGRAM_POLL_INTERVAL:-}" ]; then
    export PAPERLOOM_TELEGRAM_POLL_INTERVAL
fi

cd /app/server
exec node --enable-source-maps dist/index.js
