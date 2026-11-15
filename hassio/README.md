# Paperloom Home Assistant add-on

Paperloom is a self-hosted server for low-power e-paper photo frames. This
add-on runs the Paperloom API and management interface inside Home Assistant.

## Installation

Add this repository in Home Assistant under **Settings → Apps → App store →
⋮ → Repositories**:

```text
https://github.com/jinhong-/paperloom#hassio-release
```

Then install **Paperloom** and start it. The management interface is
available from the add-on's **Open Web UI** action.

GitHub Actions prepares the `hassio-release` branch with a self-contained copy
of the server. Home Assistant builds the app image on the installation
machine, so no container registry account or token is required.

## Version

The add-on's version is the server's version. It is written into the
generated add-on when the release branch is prepared, so the two cannot
fall out of step: Home Assistant offers an update whenever the server
inside the add-on has moved on.

## Device access

The e-paper frame cannot use the Home Assistant ingress URL because ingress
URLs contain a per-session token. Point the frame's setup screen at the
add-on's direct port instead:

```text
http://<home-assistant-host>:8099
```

For a frame outside the local network, put the add-on behind a reverse proxy
with a trusted HTTPS certificate and use that stable URL during setup.

## Data

The SQLite database, uploaded originals, and rendered assets are stored in the
add-on's private data directory:

```text
/data/paperloom
```

They survive add-on restarts and upgrades.

## Options

- `log_level`: Paperloom server log level (`trace`, `debug`, `info`, `warn`,
  `error`, or `fatal`).

The add-on automatically generates and persists a random cookie secret on
first startup. It is stored in `/share/paperloom/cookie_secret` and survives
restarts and upgrades.
