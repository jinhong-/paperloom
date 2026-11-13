/*
 * A compact 17x24 ASCII font.
 *
 * The glyphs come from the Waveshare font24 table, which is what the
 * reference firmware uses, so the setup screen looks the same as the rest
 * of the ecosystem.
 *
 * Each glyph is 17 pixels wide and 24 tall, stored as 3 bytes per row with
 * the leftmost pixel in the most significant bit of the first byte. The
 * rows are stored top down: the first row in the table is the top of the
 * letter.
 */

#ifndef FONT_ASCII_H
#define FONT_ASCII_H

#include <stdint.h>

#define FONT_WIDTH 17
#define FONT_HEIGHT 24
#define FONT_FIRST_CHAR 0x20
#define FONT_LAST_CHAR 0x7e

/* Bytes per glyph row. */
#define FONT_ROW_BYTES ((FONT_WIDTH + 7) / 8)

/* Bytes per glyph. */
#define FONT_GLYPH_BYTES (FONT_ROW_BYTES * FONT_HEIGHT)

/**
 * The glyph data, one entry per character from space to tilde.
 */
extern const uint8_t font_ascii_17x24[FONT_LAST_CHAR - FONT_FIRST_CHAR + 1][FONT_GLYPH_BYTES];

#endif /* FONT_ASCII_H */
