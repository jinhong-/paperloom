# Paperloom firmware.
#
# The partition table gives the application enough room for the code and
# the small pieces of state we keep in NVS. The assets and the schedule
# live on the microSD card, not in flash.

cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(paperloom)
