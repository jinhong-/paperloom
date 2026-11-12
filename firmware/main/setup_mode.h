/*
 * Setup mode.
 */

#ifndef SETUP_MODE_H
#define SETUP_MODE_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Run setup mode.
 *
 * This starts the access point, shows the setup screen and serves the
 * setup page. It does not return: once the user has given the frame its
 * settings, the frame restarts.
 */
void setup_mode_run(void);

#ifdef __cplusplus
}
#endif

#endif /* SETUP_MODE_H */
