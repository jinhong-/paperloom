# Paperloom

A self-hosted, low-power digital photo frame for e-paper displays.

A server owns the galleries, the scheduling policy and the image processing.
An ESP32-based device executes precomputed display events using locally
cached images, spending almost all of its time in deep sleep.

The hardware is the Good Display ESP32-133C02: an ESP32-S3 with a 13.3"
six-colour e-paper panel, a microSD slot and three buttons.

```text
paperloom/
├── firmware/             # ESP32-S3 firmware (ESP-IDF)
└── server/               # API, scheduling, enrolment, storage, management UI
```

## How it works

The two ideas that shape the design:

**The server owns policy; the firmware owns execution.** Gallery ordering,
shuffling, intervals, quiet hours and future algorithms are all computed on
the server. The device never decides which photo to show. It receives a
timestamped list of events and executes them verbatim. Changing the
rotation behaviour is a server-side change, not a firmware upgrade.

**The device initiates everything.** There is no persistent connection and
the server cannot wake a sleeping frame. The device wakes, checks in if it
is due, displays anything that is due, and goes back to sleep. If a check-in
fails, the frame keeps showing the picture it already has.

```text
Wake (timer or button)
  ├─ If a check-in is due:
  │     connect Wi-Fi → signed POST /sync → download missing assets
  ├─ If a display event is due:
  │     select the cached asset → refresh the panel if it changed
  ├─ Record the state that was actually applied
  └─ Power down and deep sleep
```

### Two independent schedules

| Schedule | Authority | What the device does | Needs Wi-Fi? |
|---|---|---|---|
| Check-in | Server | Contact the server at `next_sync_at` | Yes |
| Display | Server, precomputed | Show the referenced cached asset at each timestamp | No, once cached |

The server returns an absolute `next_sync_at` rather than a fixed interval,
so the check-in cadence can change without touching the device.

### Sliding window

Each check-in returns a window of display events covering the next few
hours. The device reconciles the window rather than appending to it, and
reuses any asset it already holds. The window is deliberately longer than
the check-in interval, so a failed check-in does not interrupt the display.

A materialised window is identified by a content hash rather than a
counter, so a retry produces exactly the same schedule and the device can
recognise a schedule it already has.

### Reporting state, not commands

The device reports what is actually on the panel (`displayed_asset`) in its
next check-in. That doubles as the acknowledgement: there is no separate
call after a display refresh. The server never assumes that handing over a
schedule or a URL means the picture was shown.

## The panel format

The panel is 4 bits per pixel: two pixels per byte, the even (left) pixel
in the high nibble, rows contiguous with no padding. A frame is therefore
1200 × 1600 ÷ 2 = 960,000 bytes.

Colour codes are the vendor's, and they skip 4:

| Code | Colour | Code | Colour |
|---|---|---|---|
| 0 | black | 3 | red |
| 1 | white | 5 | blue |
| 2 | yellow | 6 | green |

Code 4 is reserved. The server's ditherer works with palette *positions*
0-5 and translates them into codes when it packs the frame, so the reserved
code is never written.

An asset is a gzip stream whose inflated body is exactly one frame. The
firmware inflates it and pushes the bytes straight to the panel; it does no
image processing of its own.

`server/src/panel.ts` is the single source of truth for this layout, and
`firmware/main/app_config.h` must agree with it.

## Getting started

### The server

```bash
cd server
npm install
npm run dev
```

The server listens on port 8080 by default and serves the management UI
from `server/web/dist` if it has been built.

```bash
cd server/web
npm install
npm run build
```

Open the server in a browser, create an account, then create a gallery and
drop some photos into it. The photos are converted to the panel's colours
as they are uploaded, so what you see in the gallery is what the frame will
show.

### Home Assistant

Paperloom is also available as a Home Assistant add-on. Add this repository
under **Settings → Apps → App store → ⋮ → Repositories**:

```text
https://github.com/jinhong-/paperloom#hassio-release
```

Install and start **Paperloom**, then open it from the add-on page. The
management interface is exposed through Home Assistant ingress. Physical
frames should use the add-on's direct port (`8099`) rather than the ingress
URL, because ingress URLs contain a per-session token.

GitHub Actions prepares the `hassio-release` branch with a self-contained copy
of the server. Home Assistant builds the app image locally, so no container
registry account or token is required.

The add-on stores its database and photo assets in its private persistent data
directory (`/data/paperloom`), so they survive restarts and upgrades. See
`hassio/README.md` for installation and device-network details.

Configuration is by environment variable:

| Variable | Default | Meaning |
|---|---|---|
| `PAPERLOOM_HOST` | `0.0.0.0` | The address to listen on |
| `PAPERLOOM_PORT` | `8080` | The port to listen on |
| `PAPERLOOM_DATA_DIR` | `./data` | The database and the asset store |
| `PAPERLOOM_COOKIE_SECRET` | a development value | The session cookie secret |
| `PAPERLOOM_LOG_LEVEL` | `info` | The log level |

### The firmware

```bash
cd firmware
python build.py build          # build
python build.py flash          # flash
python build.py flash monitor  # flash and watch the log
python build.py --clean build  # start from scratch
```

`build.py` runs `idf.py`. If the ESP-IDF environment is already active it
uses it as-is; otherwise it locates the installation and the toolchain
itself, so the build works on a machine where the environment is not
permanently configured. It remembers the environment it used, because
ESP-IDF refuses to continue when the Python interpreter changes.

To use `idf.py` directly, activate the environment first:

```bash
. $IDF_PATH/export.sh          # POSIX
. $IDF_PATH\export.ps1         # PowerShell
idf.py build
```

The build needs ESP-IDF v5.3 or newer; it was developed against v6.0.1.

### The hardware

The ESP32-S3 module on this board is the **N16R8** variant: 16 MB of flash
and 8 MB of PSRAM. The flash size matters: the partition table has two
3 MB application slots so that an over-the-air update fits later.

The panel is driven over plain SPI on SPI2, with the image split across two
chip selects:

| Signal | Pin | | Signal | Pin |
|---|---|---|---|---|
| CS0 | 18 | | BUSY | 7 |
| CS1 | 17 | | RST | 6 |
| CLK | 9 | | LOAD_SW | 45 |
| MOSI | 41 | | SD CLK | 8 |
| MISO | 40 | | SD MOSI/MISO | 3 / 5 |

The microSD card has its own SPI bus on SPI3.

Good Display's product page describes the panel interface as "QSPI", which
is misleading: the *connector* is a 60-pin QSPI-style interface, but the
MCU drives it with an ordinary SPI bus, as the vendor's own sample code
does.

### Two hardware quirks worth knowing

**The flash must be DIO at 40 MHz.** The chip's eFuse records that the
flash is quad, so the ROM boots in QIO, but this flash chip is not
reliable at 80 MHz in quad mode: the image is corrupted during load and the
ROM dies in its loader, which shows up as a boot loop with no output at
all — not even the bootloader banner. DIO at 40 MHz is reliable.

**The ECC accelerator cannot generate keys.** The ESP32-S3's hardware ECC
peripheral can sign and verify but not generate a key pair, and
ESP-IDF v6's mbedTLS configuration claims the generation capability
anyway, which disables the software fallback that would otherwise handle
it. `psa_generate_key()` therefore fails with `PSA_ERROR_NOT_SUPPORTED`.

The firmware works around this by generating the private scalar in
software and importing it into a hardware key slot, so signing still uses
the accelerator.

## Development tools

These live in `server/src/tools` and are useful without any hardware.

```bash
# Render a test pattern and write a preview PNG.
npx tsx src/tools/preview.ts [input.jpg] [output.png]

# Drive the server the way the firmware does, and report what happens.
npx tsx src/tools/live-check.ts

# Enrol a simulated device and print its claim code.
npx tsx src/tools/simulate-device.ts --server http://127.0.0.1:8080
```

`simulate-device.ts` signs requests exactly as the firmware does, so if the
simulator and the firmware ever disagree about the protocol, the simulator
is the one to fix.

## Tests

```bash
cd server
npm test
```

The suite covers the panel packing, the dithering (pinned against the
reference implementation's output), request signing, schedule
materialisation, the device protocol and a full stack run from enrolment
through to downloading an asset.

## Security

- Device requests are signed with an ECDSA P-256 key. The device keeps the
  private key; the server stores only the public key.
- Each request carries a timestamp and a nonce. The server rejects
  timestamps outside a five-minute window and refuses a nonce it has
  already seen, so a captured request cannot be replayed.
- The signature covers the method, path, timestamp, nonce, device id and
  the SHA-256 of the body, so none of them can be altered in flight.
- Possession of a device id is not enough to claim a device: the claim code
  shown on the panel is a high-entropy secret that only the physical frame
  knows, and it is single-use and short-lived.
- TLS is expected in front of the server. The device will not silently
  accept an unverified certificate.

## Status

Working:

- The server, the management UI and the firmware all build and run.
- The full protocol works end to end, from enrolment to displaying a photo.
- The dithered output is bit-identical to the reference implementation.

Still to do:

- The setup portal. The device currently expects the server URL and the
  Wi-Fi credentials to be provisioned; the local access point and the
  on-screen setup page are not written yet.
- The on-screen claim code. The server issues it, but the firmware does not
  yet render it as a QR code.
- The battery measurement. The architecture notes flag that the sense pin
  is unverified, so the firmware reports no battery voltage rather than a
  made-up one.
- OTA updates and a factory reset.
