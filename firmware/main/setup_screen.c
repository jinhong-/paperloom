/*
 * The setup screen.
 *
 * The panel is 1200x1600 in portrait. The screen has to be readable from
 * across a room, so the network details are drawn large, and it has to
 * carry a QR code so that a phone can find the setup page without anyone
 * having to type an address.
 *
 * The layout is:
 *
 *     +----------------------------------+
 *     |          Paperloom               |
 *     |                                  |
 *     |   Join this network:            |
 *     |   Paperloom-1A2B                |
 *     |                                  |
 *     |   Password:                     |
 *     |   photobooth                    |
 *     |                                  |
 *     |          [QR code]              |
 *     |                                  |
 *     |   Scan to finish setup           |
 *     +----------------------------------+
 */

#include <stdio.h>
#include <string.h>

#include "esp_log.h"

#include "app_config.h"
#include "drawing.h"
#include "epaper.h"
#include "font_ascii.h"
#include "qr.h"
#include "setup_screen.h"

static const char *TAG = "setup_screen";

/* The margins around the content.
 *
 * The panel's edges are not always rendered faithfully: the bezel can
 * cover the outermost pixels of the image, and there is a border of a
 * slightly different shade around the active area. The margin is
 * generous so that nothing important is close enough to the edge to be
 * lost or clipped. */
#define MARGIN 100

void setup_screen_draw(uint8_t *buffer, const setup_screen_info_t *info) {
    const int width = PANEL_WIDTH;
    const int height = PANEL_HEIGHT;

    /* Start from a clean white panel. */
    draw_fill_rect(buffer, width, height, 0, 0, width, height, EPD_COLOR_WHITE);

    /* Markers around the edge of the picture.
     *
     * The panel is wired so that it reads the picture a particular way
     * round. These markers make it obvious which way that is: the top edge
     * is marked with red and the bottom with blue, the left edge with
     * blue and the right with green.
     *
     * They are only useful while the layout is being worked out, so they
     * are drawn only in the debug build. */
    /* Markers around the edge of the picture.
     *
     * The panel is wired so that it reads the picture a particular way
     * round. These markers make it obvious which way that is: the top edge
     * is marked with red and the bottom with blue, the left edge with
     * blue and the right with green.
     *
     * They are only useful while the layout is being worked out, so they
     * are drawn only in the debug build. */
#ifdef PAPERLOOM_PANEL_DEBUG
    draw_fill_rect(buffer, width, height, MARGIN, MARGIN, 70, 70, EPD_COLOR_RED);
    draw_fill_rect(buffer, width, height, width - MARGIN - 70, MARGIN, 70, 70, EPD_COLOR_GREEN);
    draw_fill_rect(buffer, width, height, MARGIN, height - MARGIN - 70, 70, 70, EPD_COLOR_BLUE);
    draw_fill_rect(buffer, width, height, width - MARGIN - 70, height - MARGIN - 70, 70, 70,
                   EPD_COLOR_YELLOW);
#endif

    int y = MARGIN;

    /* The title. */
    draw_text_centered(buffer, width, height, y, "Paperloom", EPD_COLOR_BLACK, 4);
    y += FONT_HEIGHT * 4 + 30;

    draw_text_centered(buffer, width, height, y, "This frame needs to be set up", EPD_COLOR_BLACK,
                       2);
    y += FONT_HEIGHT * 2 + 50;

    /* The network name. */
    draw_text_centered(buffer, width, height, y, "Join this network", EPD_COLOR_BLACK, 2);
    y += FONT_HEIGHT * 2 + 16;

    draw_text_centered(buffer, width, height, y, info->ssid, EPD_COLOR_BLACK, 4);
    y += FONT_HEIGHT * 4 + 40;

    /* The passphrase. */
    draw_text_centered(buffer, width, height, y, "Password", EPD_COLOR_BLACK, 2);
    y += FONT_HEIGHT * 2 + 16;

    draw_text_centered(buffer, width, height, y, info->password, EPD_COLOR_BLACK, 4);
    y += FONT_HEIGHT * 4 + 50;

    /* The QR code, centred. */
    const int qr_size = 560;
    const int qr_x = (width - qr_size) / 2;
    const int qr_y = y;

    if (!qr_draw(buffer, width, height, qr_x, qr_y, qr_size, info->setup_url)) {
        /* If the QR code cannot be drawn, say so rather than leaving a
         * blank space the user cannot interpret. */
        draw_text_centered(buffer, width, height, qr_y + qr_size / 2, "Open the address above",
                           EPD_COLOR_BLACK, 2);
    }
    y = qr_y + qr_size + 40;

    /* The address, for anyone whose camera will not read the code. */
    draw_text_centered(buffer, width, height, y, info->setup_url, EPD_COLOR_BLACK, 2);
    y += FONT_HEIGHT * 2 + 24;

    draw_text_centered(buffer, width, height, y, "Scan the code or open the address to finish setup",
                       EPD_COLOR_BLACK, 2);

    ESP_LOGI(TAG, "Drew the setup screen");
}

void setup_screen_draw_error(uint8_t *buffer, const char *message) {
    const int width = PANEL_WIDTH;
    const int height = PANEL_HEIGHT;

    draw_fill_rect(buffer, width, height, 0, 0, width, height, EPD_COLOR_WHITE);

    draw_text_centered(buffer, width, height, MARGIN, "Paperloom", EPD_COLOR_BLACK, 4);

    draw_text_centered(buffer, width, height, MARGIN + FONT_HEIGHT * 4 + 60, "Setup problem",
                       EPD_COLOR_BLACK, 3);

    draw_text_centered_in_band(buffer, width, height, MARGIN + FONT_HEIGHT * 4 + 160, 300, message,
                               EPD_COLOR_BLACK, 2);
}

void setup_screen_draw_claim(uint8_t *buffer, const char *claim_code, const char *claim_url) {
    const int width = PANEL_WIDTH;
    const int height = PANEL_HEIGHT;

    draw_fill_rect(buffer, width, height, 0, 0, width, height, EPD_COLOR_WHITE);

    int y = MARGIN;

    draw_text_centered(buffer, width, height, y, "Paperloom", EPD_COLOR_BLACK, 4);
    y += FONT_HEIGHT * 4 + 30;

    draw_text_centered(buffer, width, height, y, "One more step", EPD_COLOR_BLACK, 2);
    y += FONT_HEIGHT * 2 + 50;

    draw_text_centered(buffer, width, height, y, "Scan this code in the", EPD_COLOR_BLACK, 2);
    y += FONT_HEIGHT * 2 + 12;
    draw_text_centered(buffer, width, height, y, "Paperloom dashboard", EPD_COLOR_BLACK, 2);
    y += FONT_HEIGHT * 2 + 40;

    const int qr_size = 520;
    const int qr_x = (width - qr_size) / 2;
    const int qr_y = y;

    if (!qr_draw(buffer, width, height, qr_x, qr_y, qr_size, claim_url)) {
        draw_text_centered(buffer, width, height, qr_y + qr_size / 2, claim_code, EPD_COLOR_BLACK, 3);
    }
    y = qr_y + qr_size + 40;

    /* The claim code, in case the QR code cannot be scanned. */
    draw_text_centered(buffer, width, height, y, "Or enter this code", EPD_COLOR_BLACK, 2);
    y += FONT_HEIGHT * 2 + 12;
    draw_text_centered(buffer, width, height, y, claim_code, EPD_COLOR_BLACK, 3);
}
