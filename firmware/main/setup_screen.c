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
 *     |   Scan the code or open the     |
 *     |   address to finish setup       |
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
 * lost or clipped.
 *
 * The margin also sets how wide a line of text can be. At this margin
 * there is room for 27 characters at twice the base size, and 13 at four
 * times, which is what the network name and the passphrase need. */
#define MARGIN 140

/**
 * Draw text at the largest scale that still fits between the margins.
 *
 * The network name and the passphrase are drawn large so that they can
 * be read from across a room, but a long one would otherwise run off
 * the side of the panel. This steps the size down until the text fits,
 * so that a long name is shown smaller rather than being cut off.
 *
 * @param scale The largest scale to try.
 */
static void draw_text_fitting(uint8_t *buffer, int width, int height, int y, const char *text,
                              uint8_t color, int scale) {
    const int available = width - 2 * MARGIN;

    while (scale > 1 && measure_text(text, scale) > available) {
        scale--;
    }

    draw_text_centered(buffer, width, height, y, text, color, scale);
}

void setup_screen_draw(uint8_t *buffer, const setup_screen_info_t *info) {
    const int width = PANEL_WIDTH;
    const int height = PANEL_HEIGHT;

    /* Start from a clean white panel. */
    draw_fill_rect(buffer, width, height, 0, 0, width, height, EPD_COLOR_WHITE);

    int y = MARGIN;

    /* The title. */
    draw_text_centered(buffer, width, height, y, "Paperloom", EPD_COLOR_BLACK, 4);
    y += FONT_HEIGHT * 4 + 30;

    draw_text_centered(buffer, width, height, y, "This frame needs setting up", EPD_COLOR_BLACK, 2);
    y += FONT_HEIGHT * 2 + 50;

    /* The network name. */
    draw_text_centered(buffer, width, height, y, "Join this network", EPD_COLOR_BLACK, 2);
    y += FONT_HEIGHT * 2 + 16;

    draw_text_fitting(buffer, width, height, y, info->ssid, EPD_COLOR_BLACK, 4);
    y += FONT_HEIGHT * 4 + 36;

    /* The passphrase. */
    draw_text_centered(buffer, width, height, y, "Password", EPD_COLOR_BLACK, 2);
    y += FONT_HEIGHT * 2 + 16;

    draw_text_fitting(buffer, width, height, y, info->password, EPD_COLOR_BLACK, 4);
    y += FONT_HEIGHT * 4 + 40;

    /* The QR code, centred. */
    const int qr_size = 460;
    const int qr_x = (width - qr_size) / 2;
    const int qr_y = y;

    if (!qr_draw(buffer, width, height, qr_x, qr_y, qr_size, info->setup_url)) {
        /* If the QR code cannot be drawn, say so rather than leaving a
         * blank space the user cannot interpret. */
        draw_text_centered(buffer, width, height, qr_y + qr_size / 2, "Open the address above",
                           EPD_COLOR_BLACK, 2);
    }
    y = qr_y + qr_size + 32;

    /* The address, for anyone whose camera will not read the code. */
    draw_text_centered(buffer, width, height, y, info->setup_url, EPD_COLOR_BLACK, 2);
    y += FONT_HEIGHT * 2 + 18;

    /* Two lines, because the whole message does not fit on one. */
    draw_text_centered(buffer, width, height, y, "Scan the code or open the", EPD_COLOR_BLACK, 2);
    y += FONT_HEIGHT * 2 + 8;

    draw_text_centered(buffer, width, height, y, "address to finish setup", EPD_COLOR_BLACK, 2);

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
    draw_text_fitting(buffer, width, height, y, claim_code, EPD_COLOR_BLACK, 3);
}

/**
 * Draw the screen shown once the frame has been claimed.
 *
 * The frame is working and belongs to the owner now, but there is
 * nothing to show yet because no photos have been chosen. The screen
 * says so, and points at the dashboard where the photos are added.
 */
void setup_screen_draw_ready(uint8_t *buffer, const char *dashboard_url) {
    const int width = PANEL_WIDTH;
    const int height = PANEL_HEIGHT;

    draw_fill_rect(buffer, width, height, 0, 0, width, height, EPD_COLOR_WHITE);

    int y = MARGIN;

    draw_text_centered(buffer, width, height, y, "Paperloom", EPD_COLOR_BLACK, 4);
    y += FONT_HEIGHT * 4 + 30;

    draw_text_centered(buffer, width, height, y, "This frame is ready", EPD_COLOR_BLACK, 2);
    y += FONT_HEIGHT * 2 + 50;

    /* The frame has nothing to show until photos have been chosen, so
     * this is what the owner sees. Saying so is better than showing a
     * blank screen, which looks like a fault. */
    draw_text_centered(buffer, width, height, y, "Add some photos to", EPD_COLOR_BLACK, 2);
    y += FONT_HEIGHT * 2 + 12;
    draw_text_centered(buffer, width, height, y, "get it started", EPD_COLOR_BLACK, 2);
    y += FONT_HEIGHT * 2 + 40;

    const int qr_size = 460;
    const int qr_x = (width - qr_size) / 2;
    const int qr_y = y;

    if (!qr_draw(buffer, width, height, qr_x, qr_y, qr_size, dashboard_url)) {
        draw_text_centered(buffer, width, height, qr_y + qr_size / 2, dashboard_url, EPD_COLOR_BLACK,
                           2);
    }
    y = qr_y + qr_size + 32;

    draw_text_centered(buffer, width, height, y, "Open the dashboard", EPD_COLOR_BLACK, 2);
}
