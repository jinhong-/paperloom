# Paperloom Home Assistant add-on

Paperloom is a self-hosted server for low-power e-paper photo frames. This
add-on runs the Paperloom API and management interface inside Home Assistant.

## Installation

Add this repository in Home Assistant under **Settings → Add-ons → Add-on
store → ⋮ → Repositories**:

```text
https://github.com/jinhong-/paperloom
```

Then install **Paperloom** and start it. The management interface is
available from the add-on's **Open Web UI** action.

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

The SQLite database, uploaded originals, and rendered assets are stored in:

```text
/share/paperloom
```

They survive add-on restarts and upgrades. The add-on reads the persistent
`ssl` store only as the Home Assistant Supervisor provides it to add-ons.

## Options

- `log_level`: Paperloom server log level (`trace`, `debug`, `info`, `warn`,
  `error`, or `fatal`).

The add-on automatically generates and persists a random cookie secret on
first startup. It is stored in `/share/paperloom/cookie_secret` and survives
restarts and upgrades.
