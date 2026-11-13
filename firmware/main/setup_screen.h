/*
 * The setup screen.
 */

#ifndef SETUP_SCREEN_H
#define SETUP_SCREEN_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * What the setup screen shows.
 */
typedef struct {
    /** The access point's network name. */
    const char *ssid;
    /** The access point's passphrase. */
    const char *password;
    /** The address of the setup page. */
    const char *setup_url;
} setup_screen_info_t;

/**
 * Draw the setup screen.
 *
 * The screen shows the access point's name and passphrase, a QR code
 * linking to the setup page, and the address as text for anyone whose
 * camera will not read the code.
 */
void setup_screen_draw(uint8_t *buffer, const setup_screen_info_t *info);

/**
 * Draw a screen explaining that setup failed.
 */
void setup_screen_draw_error(uint8_t *buffer, const char *message);

/**
 * Draw the claim screen.
 *
 * This is shown after the frame has connected to the network and enrolled
 * with the server. The QR code carries the claim URL, and the claim code is
 * shown as text for anyone who cannot scan it.
 *
 * @param claim_code The code to enter by hand.
 * @param claim_url  The URL the QR code points at.
 */
void setup_screen_draw_claim(uint8_t *buffer, const char *claim_code, const char *claim_url);

/**
 * Draw the screen shown once the frame has been claimed.
 *
 * The frame is working and belongs to the owner, but there is nothing to
 * show until photos have been chosen. The screen says so and points at
 * the dashboard where the photos are added.
 *
 * @param dashboard_url The address of the dashboard.
 */
void setup_screen_draw_ready(uint8_t *buffer, const char *dashboard_url);

#ifdef __cplusplus
}
#endif

#endif /* SETUP_SCREEN_H */
