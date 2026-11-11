# Paperloom

**Architecture and design discussion — consolidated notes**  
**Date:** 11 November 2026  
**Status:** Working design; decisions distinguished from open questions

> This is a structured export of the discussion, not a verbatim chat transcript. It records the agreed direction, significant alternatives considered, and remaining questions.

## 1. Project overview

**Paperloom** is a self-hosted, low-power digital photo-frame system for e-paper displays. A server manages galleries, enrollment, image preparation and schedules; an ESP32-based device executes precomputed display events using locally cached images. The device operates mostly in deep sleep, with Wi-Fi enabled only when it checks in.

### Core principles

- **Server owns policy.** Gallery ordering, shuffling, prioritization, weekday/weekend behavior, quiet hours, and future algorithms are calculated centrally.
- **Firmware owns execution.** It fetches scheduled events and assets, applies them at the specified times, reports its actual state, and sleeps.
- **No continuous connection.** The device initiates all communications; the server cannot wake a sleeping frame remotely.
- **Offline-first display.** Locally cached assets support image rotation without Wi-Fi. If nothing can be updated, the e-paper simply keeps its last displayed image.
- **Minimal firmware.** Avoid implementing gallery-specific algorithms on the ESP32 and avoid unnecessary work on startup.
- **Self-hosted by design.** The server URL is required during device setup; no default hosted endpoint is assumed.

## 2. Repository and component boundaries

The project has **two top-level components only**:

```text
paperloom/
├── firmware/             # ESP32-S3 firmware (ESP-IDF)
└── server/               # API, scheduling, enrollment, storage, management UI
```

### `firmware/`

Responsibilities:

- Setup-mode Wi-Fi access point and local setup page.
- Store Wi-Fi and server settings.
- Generate or provision per-device cryptographic identity.
- Complete device enrollment.
- Make authenticated sync requests and download image assets.
- Store a local schedule and image cache (likely microSD).
- Execute timestamped display events.
- Persist actual displayed state, apply safe retries, and enter deep sleep.
- Support physical-button wakeup/manual sync and potentially other local controls.

It should **not** implement gallery selection policy, shuffle rules, quiet-hours logic, or per-gallery scheduling algorithms.

### `server/`

Responsibilities:

- Host the web-based UI for gallery, scheduling, and device management **within the server component**, not in a third top-level `web/` project.
- Store galleries, device ownership, configuration, and enrollment records.
- Implement pluggable display-order/scheduling algorithms.
- Materialize upcoming per-device display schedules.
- Prepare display-ready image assets and make them available to authorized devices.
- Provide authenticated device sync and enrollment APIs.
- Choose the next device check-in time.
- Record last-known device state from check-ins and allow credential revocation.

Whether the UI is server-rendered or a frontend bundle served by the server can be decided later. It does not need to be a separate architectural component.

## 3. The two independent schedules

We distinguished two schedules that have entirely different purposes:

| Schedule | Authority | What the device does | Wi-Fi needed? |
|---|---|---|---|
| **Server sync schedule** | Server | Contact server at `next_sync_at` | Yes |
| **Photo display schedule** | Server precomputes; device executes | Display the referenced cached asset at each scheduled timestamp | No, when cached |

- The **server returns an absolute `next_sync_at` timestamp**, not merely a fixed sync interval. This allows policy changes without firmware updates.
- The **server returns timestamped image-display events** instead of telling the device which gallery algorithm to run.
- A local scheduler wakes for the earlier of the next sync and next photo event. A physical button can also wake the device.
- The server can implement quiet hours, irregular rotation, weekday/weekend rules, weighted selection, custom display orders, seasonal images and other policies by changing the generated events and sync times.
- **Quiet hours are just server policy.** They need not force the e-paper to blank; the existing image can remain visible without a refresh.

### Example

A device could sync at 10:00, 11:00, 12:00 while the precomputed photo events are 10:15, 10:40, and 11:30. It connects to Wi-Fi only on sync wakes; rotation wakes use local cache.

## 4. Sliding-window synchronization

The server should synchronize a **precomputed window of display events**, not necessarily the entire gallery and not only a single `next_photo` instruction.

- A one-hour sync cadence can produce roughly the next hour of scheduled display events.
- A **longer lookahead buffer** (for example, 2–3 hours for a one-hour sync interval) may reduce disruption after a failed sync. The precise lookahead is a server policy, not a firmware algorithm.
- Each new sync returns the **authoritative future schedule for its window**. The device reconciles or replaces overlapping future events, rather than blindly appending duplicates.
- The same immutable asset can appear in multiple events; download it only once if already cached.
- A schedule window changing does not necessarily imply the gallery contents have changed (for example, time advances or a shuffle schedule is materialized).
- On a failed sync or when no playable future event remains, **continue showing the last displayed image**. There is no need for a separate `schedule_valid_until` field solely to express this fallback.

### Revisions

We discussed using **server-generated update timestamps** instead of integer revision counters. Keep these concepts distinct:

- **Gallery/config updated time:** when authored content/configuration changed.
- **Materialized schedule identity:** identifies which event window the device has received/applied. This may need a content hash, a window identifier, or its own revision even if the gallery timestamp is unchanged.
- **Asset ID:** an immutable content hash, such as SHA-256, for detecting and reusing cached images.

If timestamps serve as revisions, the server must ensure changes cannot accidentally share an identical revision (for example, with sufficient precision and monotonic generation). A schedule returned during retry should be deterministic for a given input state and window.

## 5. Device state sync and implicit acknowledgement

The preferred protocol is **state reconciliation**, not command delivery. The device reports **actual state**; the server responds with **desired future state**.

### `POST /sync` — illustrative request

```json
{
  "device_id": "frame-001",
  "schedule_revision": "2026-11-11T10:00:00.000Z",
  "gallery_updated_at": "2026-11-11T09:00:00.000Z",
  "displayed_asset": "sha256:aaa",
  "battery_mv": 3850,
  "firmware_version": "1.0.0",
  "wake_reason": "timer"
}
```

The request reports the last asset **successfully applied to the display**, not merely downloaded. `device_id` is an identifier, **not** proof of identity; authenticated transport/request signing supplies authentication.

### `POST /sync` — illustrative response

```json
{
  "server_time": "2026-11-11T11:00:00Z",
  "next_sync_at": "2026-11-11T12:00:00Z",
  "schedule": {
    "revision": "2026-11-11T11:00:00.000Z",
    "items": [
      { "at": "2026-11-11T11:15:00Z", "asset": "sha256:bbb" },
      { "at": "2026-11-11T11:45:00Z", "asset": "sha256:ccc" },
      { "at": "2026-11-11T12:30:00Z", "asset": "sha256:aaa" }
    ]
  },
  "assets": {
    "sha256:bbb": { "url": "/assets/bbb.bin", "sha256": "bbb" },
    "sha256:ccc": { "url": "/assets/ccc.bin", "sha256": "ccc" }
  }
}
```

This is a **proposed wire format**, not a frozen specification. The server may omit unchanged data or return asset metadata only for assets that the device needs. Relative asset URLs should be resolved against the configured trusted server origin, with normal authorization applied.

### Assets

A separate read endpoint such as `GET /assets/{hash}` transfers pre-rendered images. Prefer server-side resize, crop, dither and format conversion so the device mostly downloads and pushes display-ready bytes. Verify asset size/hash before treating it as cached. Image downloads should be authenticated or use short-lived, scoped URLs.

### ACK without a separate call

- We initially considered a dedicated ACK after each display refresh.
- **Agreed:** report `displayed_asset` in the *next* normal `/sync` request as an **implicit acknowledgement**.
- This avoids an additional Wi-Fi connection or HTTP request after a local display update.
- A failed transfer or refresh leaves the previous acknowledged displayed asset intact.
- The server must **not** assume that returning a schedule or URL means the asset was displayed.
- Retrying `/sync` must not itself advance the playlist or produce inconsistent random order.

Optional telemetry, such as last display timestamp or error code, can be added later without changing the principle.

## 6. Local caching and display behavior

- The ESP32-133C02 has a microSD slot, making it a candidate for storing pre-rendered images and schedule files; power draw and SD wiring still need verification.
- Keep schedule metadata and last successfully displayed asset in persistent storage. NVS can hold small critical state; larger schedules/assets can live on SD.
- Avoid unnecessary display refreshes when the newly scheduled asset is already displayed.
- During synchronization, reuse cached hashes and fetch only missing assets.
- Do not delete the old usable assets before verifying replacements. An interrupted transfer should not blank the frame.
- A missing asset can be skipped or deferred; **the last image stays on the e-paper**.
- For robustness, stage and verify downloads and schedule updates before making them active. The exact commit approach can stay simple in the MVP.
- Local playback should be possible with the radio fully off between check-ins.

## 7. Wake-up, retry and power model

Normal operational loop:

```text
Wake (timer or local button)
  ├─ If sync due or manual local sync requested:
  │     connect Wi-Fi → authenticated POST /sync → fetch missing assets
  ├─ If a display event is due:
  │     select cached asset → refresh e-paper if different
  ├─ Save successful actual state / next events
  └─ Power down peripherals and enter deep sleep
```

- On sync failure, use a **bounded local retry/backoff**; no elaborate schedule-expiry behavior is required.
- The server tells the device when to sync next. Local fallback retry behavior remains necessary if the device never receives that instruction.
- Since a device in deep sleep has Wi-Fi off, **there is no remote “Sync Now” button** in this architecture. Server-side updates take effect only at the next device check-in.
- A **physical button** may initiate a manual sync by waking the ESP32; this is distinct from remotely waking it.
- E-paper holds the last image without continuous power, making the failure mode intentionally simple.
- Time accuracy matters for absolute UTC display events. A server-provided time and periodic synchronization can correct drift; the device should handle cold boot or invalid time before executing timed events.
- Optimize the wake/startup path because a deep-sleep wake behaves much like a reboot.

## 8. Setup and enrollment

The design has three modes:

### A. Setup mode (local)

1. On first boot or deliberate reset, the device starts its own Wi-Fi AP.
2. The **e-paper screen shows the AP details**, including network name, password and optionally a QR code.
3. The user connects a phone or computer to the AP, opens the local setup portal and enters three required fields:
   - Home Wi-Fi network/SSID
   - Home Wi-Fi password
   - **Server URL** (mandatory for this self-hosted project; no default)
4. The device joins Wi-Fi and checks connectivity to the configured server.

A local IP/hostname may be supported. HTTPS certificate trust must be handled correctly: a self-hosted or private CA may require explicit trust configuration; do not silently disable server verification.

### B. Enrollment mode (ownership claim)

1. The device generates a per-device identity/key pair or otherwise receives a secure device credential.
2. It contacts the configured server and establishes a **pending enrollment**.
3. The server issues a short-lived, one-time claim code/URL.
4. The e-paper displays **both a QR code and manually enterable code**.
5. The user scans the QR or manually visits the enrollment page, signs in and claims the device.
6. The server associates the device with the user/account and activates its credentials.
7. The device learns enrollment is complete (short-term polling is acceptable during enrollment), downloads an initial schedule/assets and enters normal operation.

QR and manual entry are two entry points into **the same ownership-claim flow**.

Security note: device-generated public keys must be securely bound to the pending claim; possession of an easily guessed device ID is insufficient. The protocol should prevent a remote attacker from claiming or substituting a device during enrollment. Showing a confirmation code on the physical display or using a per-session challenge is a useful mechanism to evaluate.

### C. Operational mode

Normal authenticated periodic `/sync`, local event execution, deep sleep.

### Lifecycle distinctions

- Changing Wi-Fi settings should **not** silently erase ownership or require a new device identity.
- Switching to a different server is a change in trust boundary and should require explicit re-enrollment.
- Unpair, transfer, revoke, and factory-reset paths need separate design.
- A full factory reset should erase credentials, Wi-Fi settings and cached private content, while preserving the ability to set up again.

## 9. Authentication and transport

**Agreed baseline:** encrypted, authenticated HTTPS traffic. The group discussed three approaches for device authentication but **did not finalize one**.

| Model | Device stores | Server verifies | Key trade-off |
|---|---|---|---|
| Bearer token | Unique token | Token lookup | Simple implementation, bearer secret exposed if extracted |
| mTLS | Device private key + client certificate | Verified client certificate / trust chain | Standard authentication at TLS layer, requires ingress client-cert support |
| Asymmetric signed requests | Private key | Registered public key | Works with ordinary HTTPS ingress, requires signing/replay protocol |

Clarification: **HMAC uses a shared symmetric secret**, not a public/private-key pair. The proposed "client private key, server public key" design is an **asymmetric signature** (e.g. ECDSA), not HMAC.

For signed HTTP requests, cover at least method, path/query, request-body digest and replay-defense material (nonce/counter/timestamp); specify canonicalization, authorization, and anti-replay behavior. HTTPS remains necessary for confidentiality and server authentication.

For mTLS, the server can authenticate the device during TLS and map its validated identity to an enrolled device record. Device certificates still need issuance, replacement, revocation and expiration recovery.

Bearer credentials likewise need provisioning/revocation/replacement. Neither model makes lifecycle concerns disappear.

The ESP32-S3 offers cryptographic capabilities, including a hardware digital-signature peripheral, but exact hardware-backed credential provisioning should be evaluated separately rather than assumed to be trivial.

**Decision pending:** mTLS versus signed HTTPS requests. Both support the proposed enrollment and sync architecture.

## 10. Hardware discussion and cautions

Current hardware is the **Good Display ESP32-133C02**, paired with a 13.3-inch e-paper display. The project also explored using thin single-cell LiPo pouch batteries (three 3.7 V, 10,000 mAh units purchased) to reduce enclosure thickness compared with 18650 cells.

### Observations and tentative findings

- The board is based on an ESP32-S3 and exposes various display signals, buttons, USB ports, a microSD slot and unlabeled test pads.
- The manufacturer sample firmware primarily exercises the display. It should not be assumed to be optimized for fast boot or deep sleep.
- GPIO1 / GPIO2 were investigated as possible ADC inputs for battery-voltage monitoring. Continuity tests suggested some pads connect to ESP32 pins, but **board-level availability of each pin is not fully established**; documentation also suggested GPIO2 may be used as `EPD_DC` in other firmware/board arrangements. Do not lock the design to either pin without verification.
- Three physical switches were reported in board documentation as SW2/GPIO12, SW3/GPIO13, SW4/GPIO14; verify polarity and wake behavior on this specific board before relying on them.
- The second-from-right contact of an unidentified five-pin connector was measured as GND. **The connector's full purpose/pinout remains unknown.** Do not attach power or UART wiring based on a guess.
- The lower USB-C marked `battr` is described as a Type-C lithium-battery/power interface, but this **does not establish direct support for an unregulated 3.0–4.2 V LiPo**.
- Published board information points to **5 V Type-C input**. A visible AMS1117-3.3 regulator suggests raw 3.7 V input may not hold 3.3 V reliably, depending on its actual power path.
- **Do not directly connect a bare LiPo to that USB-C port without verification.** A protected battery, appropriate charger and (if necessary) regulated 5 V boost supply remain the conservative power architecture.
- Thin wires soldered to test pads are simplest mechanically; pogo-pin contacts in a printed fixture were considered as a reversible alternative.

These are exploration notes, **not** an approved hardware wiring or battery charging specification.

## 11. Decisions, non-goals and open questions

### Decisions captured

1. Name: **Paperloom**.
2. **Exactly two top-level components:** `firmware/` and `server/`; management UI is part of the server.
3. Device-initiated communication only; no server-initiated remote wake or remote **Sync Now**.
4. Separate server sync and photo display schedules.
5. Server returns absolute `next_sync_at` and precomputed timestamped display events.
6. Local cache permits photo changes without Wi-Fi.
7. Last successfully displayed e-paper image is the fallback if sync/download/display cannot proceed.
8. State-based `/sync` reports actual displayed state; this serves as an implicit ACK.
9. No separate display ACK request required for MVP.
10. Setup portal requires Wi-Fi credentials **and a mandatory server URL**.
11. Ownership enrollment supports QR and manual claim-code paths.
12. Use HTTPS; choose device credential strategy separately.

### Open questions / implementation choices

- **Authentication:** mTLS or application-layer asymmetric request signing? How will credentials be stored, enrolled and recovered?
- **Server TLS trust:** How will a device safely trust a local/self-hosted server certificate or private CA on first setup?
- **Schedules:** How exactly are schedule windows identified and reconciled when events overlap or change? What are tie-breaking rules for equal timestamps?
- **Cache:** Confirm SD support, power behavior, storage layout and staging/commit strategy. Determine practical cache size.
- **Clock:** RTC accuracy across deep sleep, startup time acquisition, behavior after lost time, and handling missed events.
- **Physical buttons:** Verify switch mapping/polarity and whether wake from deep sleep is reliable; decide final gestures for manual sync and reset.
- **Provisioning security:** Prevent takeover of device-generated identities or claim codes during enrollment; confirm a practical proof-of-possession design.
- **Power:** Verify 5 V supply architecture, battery charger/boost efficiency, sleep leakage and ADC wiring before finalizing the enclosure.
- **Media:** Define exact display-ready binary format and checksum verification workflow.

## 12. Minimal operating contract (summary)

```text
server/                                  firmware/
---------                                ---------
Own galleries, user/device records       Own Wi-Fi/server provisioning
Own selection & scheduling algorithms    Own device identity
Render images to display-ready assets    Cache assets and schedule
Return next_sync_at                      Wake at next sync or display event
Return timestamped schedule             POST actual state to /sync
Serve missing assets                    GET/verify missing image assets
Read implicit ACK at next check-in       Refresh only when needed
                                         Keep last image on failures
                                         Deep sleep between events
```

**In one sentence:** Paperloom is a server-programmable e-paper photo frame whose firmware only synchronizes state, caches immutable assets, executes precomputed display events and sleeps.
