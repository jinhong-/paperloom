/*
 * Setup mode.
 *
 * When the frame has no server URL it cannot do anything useful, so it
 * starts an access point, shows a screen explaining what to do, and serves
 * a setup page until the user has given it what it needs.
 *
 * The mode ends when the settings have been stored. The frame then
 * restarts, joins the home network and carries on into normal operation.
 */

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_err.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "app_config.h"
#include "board.h"
#include "display_task.h"
#include "epaper.h"
#include "setup_mode.h"
#include "setup_screen.h"
#include "setup_server.h"
#include "sync.h"

static const char *TAG = "setup";

/* The access point's name and passphrase. */
static char s_ap_ssid[32];
static char s_ap_password[16];

/**
 * Read a stored value, or a default.
 */
static bool read_or_default(const char *key, char *out, size_t out_len, const char *fallback) {
    nvs_handle_t nvs;
    if (nvs_open("paperloom", NVS_READONLY, &nvs) != ESP_OK) {
        snprintf(out, out_len, "%s", fallback);
        return false;
    }

    size_t len = out_len;
    esp_err_t err = nvs_get_str(nvs, key, out, &len);
    nvs_close(nvs);

    if (err != ESP_OK || out[0] == '\0') {
        snprintf(out, out_len, "%s", fallback);
        return false;
    }
    return true;
}

/**
 * Work out the access point's name and passphrase.
 *
 * The name is derived from the device id so that it is recognisable, and
 * the passphrase is random and stored, so that it does not change every
 * time the frame reboots and confuse the person setting it up.
 */
static void prepare_ap_credentials(void) {
    const char *device_id = sync_device_id();

    /* Paperloom-XXXX, where XXXX comes from the device id. */
    char suffix[8] = "0000";
    if (device_id != NULL && device_id[0] != '\0') {
        size_t len = strlen(device_id);
        const char *tail = device_id + (len > 4 ? len - 4 : 0);
        for (int i = 0; i < 4 && tail[i] != '\0'; i++) {
            if ((tail[i] >= '0' && tail[i] <= '9') || (tail[i] >= 'a' && tail[i] <= 'f')) {
                suffix[i] = tail[i];
            }
        }
    }
    snprintf(s_ap_ssid, sizeof(s_ap_ssid), "Paperloom-%s", suffix);

    /* The passphrase is stored so that it survives a reboot. */
    if (!read_or_default("ap_pass", s_ap_password, sizeof(s_ap_password), "")) {
        static const char alphabet[] = "abcdefghijkmnopqrstuvwxyz23456789";
        uint8_t random[10];
        esp_fill_random(random, sizeof(random));
        for (size_t i = 0; i < sizeof(random); i++) {
            s_ap_password[i] = alphabet[random[i] % (sizeof(alphabet) - 1)];
        }
        s_ap_password[sizeof(random)] = '\0';

        nvs_handle_t nvs;
        if (nvs_open("paperloom", NVS_READWRITE, &nvs) == ESP_OK) {
            nvs_set_str(nvs, "ap_pass", s_ap_password);
            nvs_commit(nvs);
            nvs_close(nvs);
        }
    }
}

/**
 * The address of the setup page.
 */
static void build_setup_url(char *out, size_t out_len) {
    snprintf(out, out_len, "http://%s/", board_ap_address());
}

/**
 * Store the settings the user entered.
 */
esp_err_t setup_apply(const char *server_url, const char *ssid, const char *password) {
    if (server_url == NULL || server_url[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }

    if (sync_set_server_url(server_url) != ESP_OK) {
        return ESP_FAIL;
    }

    if (ssid != NULL && ssid[0] != '\0') {
        if (board_set_wifi_credentials(ssid, password ? password : "") != ESP_OK) {
            return ESP_FAIL;
        }
    }

    ESP_LOGI(TAG, "Settings stored: server %s, Wi-Fi %s", server_url,
             ssid ? ssid : "(unchanged)");
    return ESP_OK;
}

/**
 * Restart the frame.
 */
void setup_restart(void) {
    ESP_LOGI(TAG, "Restarting");
    esp_restart();
}

/**
 * The frame's device identifier.
 */
const char *setup_device_id(void) {
    return sync_device_id();
}

/**
 * The name the frame answers to on the network.
 */
const char *setup_hostname(void) {
    return s_ap_ssid;
}

/**
 * The firmware version.
 */
const char *setup_firmware_version(void) {
    return APP_VERSION;
}

/**
 * Run setup mode until the user has given the frame what it needs.
 *
 * This does not return: once the settings are stored the frame restarts.
 */
void setup_mode_run(void) {
    ESP_LOGI(TAG, "Starting setup mode");

    ESP_ERROR_CHECK(sync_ensure_device_id());
    prepare_ap_credentials();

    /* Bring up the access point. */
    ESP_ERROR_CHECK(board_wifi_start_ap(s_ap_ssid, s_ap_password));

    /* Show the screen. */
    char setup_url[64];
    build_setup_url(setup_url, sizeof(setup_url));

    setup_screen_info_t info = {
        .ssid = s_ap_ssid,
        .password = s_ap_password,
        .setup_url = setup_url,
    };

    ESP_ERROR_CHECK(display_task_show_setup_screen(&info));

    /* Serve the setup page. */
    httpd_handle_t server = NULL;
    esp_err_t err = setup_server_start(&server);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "The setup server would not start");
        /* There is nothing the user can do without the page, so keep the
         * screen up and wait. */
        while (true) {
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }

    ESP_LOGI(TAG, "Setup mode is running: join \"%s\" and open %s", s_ap_ssid, setup_url);

    /* Wait for the settings to be stored. The restart is triggered by the
     * request handler, so this loop only has to stay out of the way. */
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
