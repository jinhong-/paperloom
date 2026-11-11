/*
 * Small helpers shared across the firmware.
 */

#include <stdio.h>
#include <string.h>

#include "utils.h"

const char *StringifyInt(int64_t value) {
    /* The buffer is static so the result stays valid after the call, which
     * is what the HTTP header setter needs. */
    static char buffer[24];
    snprintf(buffer, sizeof(buffer), "%lld", (long long)value);
    return buffer;
}

/**
 * Days from the civil epoch.
 *
 * Howard Hinnant's algorithm for converting a civil date to a day count.
 * It avoids the need for a time zone database on the device.
 */
static int64_t days_from_civil(int64_t y, unsigned m, unsigned d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = (unsigned)(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + (int64_t)doe - 719468;
}

esp_err_t parse_iso8601_ms(const char *text, int64_t *out_ms) {
    if (text == NULL || out_ms == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    int year, month, day, hour, minute, second;
    int matched = sscanf(text, "%d-%d-%dT%d:%d:%d", &year, &month, &day, &hour, &minute, &second);
    if (matched != 6) {
        return ESP_ERR_INVALID_ARG;
    }

    if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 ||
        minute > 59 || second < 0 || second > 60) {
        return ESP_ERR_INVALID_ARG;
    }

    int64_t days = days_from_civil(year, (unsigned)month, (unsigned)day);
    int64_t seconds = days * 86400 + hour * 3600 + minute * 60 + second;
    *out_ms = seconds * 1000;
    return ESP_OK;
}
