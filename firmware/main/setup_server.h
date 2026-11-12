/*
 * The setup web server.
 */

#ifndef SETUP_SERVER_H
#define SETUP_SERVER_H

#include "esp_err.h"
#include "esp_http_server.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Start the setup web server.
 *
 * The server listens on the access point's address and serves the setup
 * page, the endpoint that stores the configuration, and a small status
 * endpoint.
 *
 * @param out_handle The handle of the running server.
 */
esp_err_t setup_server_start(httpd_handle_t *out_handle);

/**
 * Store the settings the user entered and prepare for a restart.
 *
 * @param server_url The Paperloom server's address.
 * @param ssid       The home Wi-Fi's name.
 * @param password   The home Wi-Fi's password.
 */
esp_err_t setup_apply(const char *server_url, const char *ssid, const char *password);

/**
 * Restart the frame.
 *
 * The radio has to be reconfigured for the home network, which means
 * starting over.
 */
void setup_restart(void);

/**
 * The frame's device identifier.
 */
const char *setup_device_id(void);

/**
 * The name the frame answers to on the network.
 */
const char *setup_hostname(void);

/**
 * The firmware version.
 */
const char *setup_firmware_version(void);

#ifdef __cplusplus
}
#endif

#endif /* SETUP_SERVER_H */
