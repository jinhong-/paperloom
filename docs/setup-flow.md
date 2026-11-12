# The setup flow

How a frame goes from "just plugged in" to "showing photos".

## The problem

The device needs three things before it can do anything useful:

- the home Wi-Fi credentials,
- the URL of the server,
- an identity, so the server knows who it is.

None of them can be typed into the frame, because it has no keyboard. The
frame has a screen, though, and a phone or laptop will be nearby, because
somebody just plugged it in.

## The flow

```
 1. The frame boots and finds no configuration.
 2. It starts a Wi-Fi access point called "Paperloom-XXXX".
 3. It draws a setup screen on the panel: the network name, the
    passphrase, and a QR code linking to the setup page.
 4. It serves a small setup page on the access point.
 5. The user joins the network and opens http://192.168.4.1/ (the QR
    code points there, so scanning it does both steps at once).
 6. The page asks for the home Wi-Fi details and the server URL.
 7. The page sends them to the frame, which stores them in NVS.
 8. The frame connects to the home network, enrols with the server,
    and shows a QR code with the claim code.
 9. The user scans the claim code in the management UI and the frame
    belongs to them.
10. The frame sleeps and starts rotating photos.
```

Steps 1-4 happen on the frame. Step 6 is the setup page. Step 8-9
involve the server.

## Why the access point, rather than a serial cable

The alternative is to configure the frame over the USB serial console.
That works, but it means a laptop and a cable on the bench for every
reconfiguration, and it is not something that can be done by whoever
installed the frame. The access point is a one-time cost: the frame is
plugged in, the user joins a network that is written on the panel, and
the rest happens in a browser.

## Why two QR codes

The first one points at the frame's own setup page. The second one
carries the claim code that binds the frame to an account on the server.

They could be combined: the setup page could enrol the frame with the
server directly and show the claim code there. That would mean the frame
never has to talk to the server during setup, which is simpler for the
firmware. But it requires the setup page to reach the server, and the
phone is on the frame's access point, which has no route to the internet.
The frame would have to proxy it. Two codes keeps the two trust
boundaries separate: the first is local, the second goes to the server.

## The setup page

It is served by the frame itself, from a small HTTP server on the
access point. It has three fields:

| Field | Notes |
|---|---|
| Home Wi-Fi name | The network the frame should join |
| Home Wi-Fi password | WPA2; WPA3-only networks are not supported |
| Server URL | Required. There is no default: the project is self-hosted |

The page is plain HTML, served from a string in flash. It has no
dependencies, because the frame is the one serving it and every byte
counts.

The page POSTs to `/api/setup` on the frame. The frame stores the
credentials, then replies with what it managed to do, so the page can
tell the user whether it worked.

## The setup screen

The panel is 1200x1600 in portrait. The screen shows:

- the access point's name, large,
- the passphrase, large,
- a QR code linking to the setup page,
- a short line of instructions.

The QR code is the fastest path: scan it and the phone opens the setup
page directly. The text is the fallback for a camera that will not focus
or a reader that does not open URLs.

## What the frame does when it has no configuration

This is decided at boot, before anything else:

```
if (no server URL stored) {
    start the access point
    show the setup screen
    serve the setup page
    wait for the user to finish, or for a button press
} else {
    normal operation
}
```

The frame stays in setup mode until it has been given a server URL. It
does not go to sleep in the meantime, because it has to be reachable.
That means it draws more power than usual, which is expected: setup is a
one-off.

## Failures worth handling

**The frame cannot reach the server.** The setup page reports it. The
frame retries in the background, so a server that is not up yet does not
need the user to start over.

**The home Wi-Fi details are wrong.** The frame reports the failure and
stays in setup mode, showing the screen again.

**The server URL is wrong.** Same: the frame reports it and stays in
setup mode.

**The user never finishes.** The frame stays in setup mode indefinitely.
There is no timeout, because a half-configured frame that has silently
given up is worse than one that is still waiting.

## The reset path

Holding the reset button during boot clears the stored configuration and
restarts setup mode. This is the way out of a frame that was pointed at
a server that no longer exists.

The button's mapping is not yet verified on this board, so the reset is
held until it is.
