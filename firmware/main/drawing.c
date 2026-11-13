/*
 * Drawing onto the panel.
 *
 * The panel buffer is 4 bits per pixel: two pixels per byte, the even
 * pixel in the high nibble. This module puts pixels, text, shapes and QR
 * codes into that buffer.
 *
 * Only the black and white colours are used, because a setup screen has no
 * need for the others and the two-colour rendering is the easiest to read
 * on an e-paper panel.
 */

#include <string.h>

#include "drawing.h"
#include "font_ascii.h"

void draw_pixel(uint8_t *buffer, int width, int height, int x, int y, uint8_t color) {
    if (x < 0 || x >= width || y < 0 || y >= height) {
        return;
    }

    /* The even pixel is in the high nibble. */
    size_t offset = (size_t)y * (width / 2) + (size_t)(x / 2);
    uint8_t *byte = &buffer[offset];

    if ((x % 2) == 0) {
        *byte = (uint8_t)((*byte & 0x0f) | (color << 4));
    } else {
        *byte = (uint8_t)((*byte & 0xf0) | color);
    }
}

void draw_fill_rect(uint8_t *buffer, int width, int height, int x, int y, int w, int h,
                    uint8_t color) {
    for (int row = 0; row < h; row++) {
        for (int col = 0; col < w; col++) {
            draw_pixel(buffer, width, height, x + col, y + row, color);
        }
    }
}

void draw_rect_outline(uint8_t *buffer, int width, int height, int x, int y, int w, int h,
                        uint8_t color) {
    if (w <= 0 || h <= 0) {
        return;
    }
    draw_fill_rect(buffer, width, height, x, y, w, 1, color);
    draw_fill_rect(buffer, width, height, x, y + h - 1, w, 1, color);
    draw_fill_rect(buffer, width, height, x, y, 1, h, color);
    draw_fill_rect(buffer, width, height, x + w - 1, y, 1, h, color);
}

void draw_hline(uint8_t *buffer, int width, int height, int x, int y, int len, uint8_t color) {
    draw_fill_rect(buffer, width, height, x, y, len, 1, color);
}

void draw_vline(uint8_t *buffer, int width, int height, int x, int y, int len, uint8_t color) {
    draw_fill_rect(buffer, width, height, x, y, 1, len, color);
}

/**
 * Draw a single character.
 *
 * @return The advance in pixels.
 */
int draw_char(uint8_t *buffer, int width, int height, int x, int y, char c, uint8_t color) {
    unsigned char code = (unsigned char)c;
    if (code < FONT_FIRST_CHAR || code > FONT_LAST_CHAR) {
        code = '?';
    }

    const uint8_t *glyph = font_ascii_17x24[code - FONT_FIRST_CHAR];

    /* The font table is the Waveshare font24, which stores each glyph
     * top row first, and each row left to right, with the leftmost pixel
     * in the top bit of the first byte.
     *
     * So the glyph is read straight out of the table: row by row from
     * the start, and within each row, pixel by pixel from the left. */
    for (int row = 0; row < FONT_HEIGHT; row++) {
        const uint8_t *row_bytes = &glyph[row * FONT_ROW_BYTES];
        for (int col = 0; col < FONT_WIDTH; col++) {
            int byte_index = col / 8;
            int bit_index = 7 - (col % 8);
            if (row_bytes[byte_index] & (1 << bit_index)) {
                draw_pixel(buffer, width, height, x + col, y + row, color);
            }
        }
    }

    return FONT_WIDTH;
}

/**
 * Draw a string.
 *
 * @return The width in pixels that was drawn.
 */
int draw_text(uint8_t *buffer, int width, int height, int x, int y, const char *text,
               uint8_t color) {
    int cursor = x;
    while (*text != '\0') {
        if (*text == '\n') {
            y += FONT_HEIGHT;
            cursor = x;
            text++;
            continue;
        }
        cursor += draw_char(buffer, width, height, cursor, y, *text, color);
        text++;
    }
    return cursor - x;
}

/**
 * Draw a string scaled up.
 *
 * The setup screen has to be readable from across a room, and a 17-pixel
 * glyph is not, so the network details are drawn at two or three times the
 * base size.
 *
 * @param scale The integer scale factor; 1 leaves the text alone.
 */
int draw_text_scaled(uint8_t *buffer, int width, int height, int x, int y, const char *text,
                      uint8_t color, int scale) {
    if (scale <= 1) {
        return draw_text(buffer, width, height, x, y, text, color);
    }

    int cursor = x;
    while (*text != '\0') {
        if (*text == '\n') {
            y += FONT_HEIGHT * scale;
            cursor = x;
            text++;
            continue;
        }

        /* Draw the glyph into a scratch area so it can be scaled up. */
        uint8_t glyph[FONT_WIDTH * FONT_HEIGHT];
        memset(glyph, 0, sizeof(glyph));

        unsigned char code = (unsigned char)*text;
        if (code < FONT_FIRST_CHAR || code > FONT_LAST_CHAR) {
            code = '?';
        }
        const uint8_t *source = font_ascii_17x24[code - FONT_FIRST_CHAR];
        for (int row = 0; row < FONT_HEIGHT; row++) {
            const uint8_t *row_bytes = &source[row * FONT_ROW_BYTES];
            for (int col = 0; col < FONT_WIDTH; col++) {
                int byte_index = col / 8;
                int bit_index = 7 - (col % 8);
                if (row_bytes[byte_index] & (1 << bit_index)) {
                    glyph[row * FONT_WIDTH + col] = 1;
                }
            }
        }

        for (int row = 0; row < FONT_HEIGHT; row++) {
            for (int col = 0; col < FONT_WIDTH; col++) {
                if (!glyph[row * FONT_WIDTH + col]) {
                    continue;
                }
                draw_fill_rect(buffer, width, height, cursor + col * scale, y + row * scale, scale,
                               scale, color);
            }
        }

        cursor += FONT_WIDTH * scale;
        text++;
    }
    return cursor - x;
}

/**
 * The width a string would occupy, without drawing it.
 */
int measure_text(const char *text, int scale) {
    int length = 0;
    while (*text != '\0') {
        if (*text == '\n') {
            break;
        }
        length++;
        text++;
    }
    return length * FONT_WIDTH * scale;
}

/**
 * The height a string would occupy, without drawing it.
 */
int measure_text_height(const char *text, int scale) {
    int lines = 1;
    while (*text != '\0') {
        if (*text == '\n') {
            lines++;
        }
        text++;
    }
    return lines * FONT_HEIGHT * scale;
}

/**
 * Draw text centred horizontally.
 */
void draw_text_centered(uint8_t *buffer, int width, int height, int y, const char *text,
                        uint8_t color, int scale) {
    int text_width = measure_text(text, scale);
    int x = (width - text_width) / 2;
    if (x < 0) {
        x = 0;
    }
    draw_text_scaled(buffer, width, height, x, y, text, color, scale);
}

/**
 * Draw text centred horizontally and vertically within a band.
 */
void draw_text_centered_in_band(uint8_t *buffer, int width, int height, int band_top, int band_height,
                                const char *text, uint8_t color, int scale) {
    int text_height = measure_text_height(text, scale);
    int y = band_top + (band_height - text_height) / 2;
    if (y < 0) {
        y = 0;
    }
    draw_text_centered(buffer, width, height, y, text, color, scale);
}
