# Changelog

## [0.2.0](https://github.com/jinhong-/paperloom/compare/paperloom-firmware-v0.1.0...paperloom-firmware-v0.2.0) (2026-11-15)


### Features

* a frame shows one gallery, and a gallery says when it changes ([078d1b7](https://github.com/jinhong-/paperloom/commit/078d1b7479d21cd80e325abfca0ef91bf26231cf))
* a frame shows one gallery, and a gallery says when it changes ([#7](https://github.com/jinhong-/paperloom/issues/7)) ([078d1b7](https://github.com/jinhong-/paperloom/commit/078d1b7479d21cd80e325abfca0ef91bf26231cf))
* a gallery says when it changes, and how its pictures look ([980e3ca](https://github.com/jinhong-/paperloom/commit/980e3ca694123fb6e5b50f44bd1cf8e30a30df73))
* a gallery says when it changes, and how its pictures look ([#6](https://github.com/jinhong-/paperloom/issues/6)) ([980e3ca](https://github.com/jinhong-/paperloom/commit/980e3ca694123fb6e5b50f44bd1cf8e30a30df73))
* show a picture next, and keep more of them on the frame ([1dbd5bf](https://github.com/jinhong-/paperloom/commit/1dbd5bf82b29168c7e664e1c294ca7c0c9de3f00))
* show a picture next, and keep more of them on the frame ([#8](https://github.com/jinhong-/paperloom/issues/8)) ([1dbd5bf](https://github.com/jinhong-/paperloom/commit/1dbd5bf82b29168c7e664e1c294ca7c0c9de3f00))


### Bug Fixes

* a frame waiting to be claimed can be found and claimed ([f6b104d](https://github.com/jinhong-/paperloom/commit/f6b104d5fafe9bae4c626de4064607cc300886a8))
* a picture asked for is not missed by the frame ([397ae76](https://github.com/jinhong-/paperloom/commit/397ae7610e66f3f023e45fe1569c32151d5e314e))
* give the frame a picture at once, and recover from a refused clock ([120cb6e](https://github.com/jinhong-/paperloom/commit/120cb6e5646aa368b4b5eee3311778c91f2784a0))
* keep the schedule stable, and extend it rather than replace it ([6a002b7](https://github.com/jinhong-/paperloom/commit/6a002b7d34d2e98d20f6baac15c5431e346bea1d))
* plan the photos at least as far apart as the frame checks in ([d3b3d99](https://github.com/jinhong-/paperloom/commit/d3b3d99c59a0530d81a4a4b18be98a42808abee3))
* the frame asks the server for the time when it has lost its power ([078d1b7](https://github.com/jinhong-/paperloom/commit/078d1b7479d21cd80e325abfca0ef91bf26231cf))
* the frame takes the claim code off the panel once it is claimed ([2507760](https://github.com/jinhong-/paperloom/commit/25077604860fe8d3bdb729f07b81aeaccca98ab2))


### Server

* check-in rules, a time zone picker, and photo previews ([83dbba4](https://github.com/jinhong-/paperloom/commit/83dbba4b9d5f8b16ba798554dfaea81266023dc7))
* rebuild a schedule when the device's inputs change ([8739a7c](https://github.com/jinhong-/paperloom/commit/8739a7c9b8b2d115feeeda89616bb8474e8a3e68))


### Firmware

* a signed sync that the server accepts ([24bd8a0](https://github.com/jinhong-/paperloom/commit/24bd8a056327f32d6415acf00307172647c8904a))
* cross-platform build script and corrected hardware settings ([3f39beb](https://github.com/jinhong-/paperloom/commit/3f39beb488837060bf64c040e89fea1f8758d4ce))
* decide whether to check in without trusting the clock ([cc3748a](https://github.com/jinhong-/paperloom/commit/cc3748a3c6f192f6219c2f5bf4e1dcb7d7bc5b11))
* do not turn the picture on its way to the panel ([2603304](https://github.com/jinhong-/paperloom/commit/2603304119df17e3bb0b7e98b9c47c8e23e03c8e))
* ESP32-133C02 firmware for Paperloom ([9cc4507](https://github.com/jinhong-/paperloom/commit/9cc45074a0d4e3768c67dfcaf34fe79afeb6a1b0))
* fix the reset button and the wake source ([3c1da6b](https://github.com/jinhong-/paperloom/commit/3c1da6b9c34d887863e91700398ec0b90925a8b2))
* keep a bounded LRU image cache ([31353f2](https://github.com/jinhong-/paperloom/commit/31353f2a093eef2fbfd25ebea6a11a96290fba44))
* make the firmware run on the real board ([9cb65e9](https://github.com/jinhong-/paperloom/commit/9cb65e94f2fef9477720390b5694797ac12c91c2))
* restore the component's source list ([afd9d59](https://github.com/jinhong-/paperloom/commit/afd9d591aede5e16f3e728a5949ffec5be90e61f))
* store the cache in a filesystem that has no directories ([cf3f13e](https://github.com/jinhong-/paperloom/commit/cf3f13e0b2d3c34d72087ebb0f06007f2378f7cb))
* take the diagnostic out of the wake calculation ([03c4636](https://github.com/jinhong-/paperloom/commit/03c4636c9936ec9229c18ce9d7a6c28090a59c2b))
* the frame checks in when its schedule runs out ([c6d2264](https://github.com/jinhong-/paperloom/commit/c6d226412b870103d614bb9a9b29cd890ef8efd8))
* the setup flow, and a working request path ([0933bd5](https://github.com/jinhong-/paperloom/commit/0933bd59c376d9c79db6e545a9dbcdc568a56e5b))
* the text glyphs were mirrored ([17b21b1](https://github.com/jinhong-/paperloom/commit/17b21b1d267c1fe333ad53711ae93484eb4cee43))
* the text was upside down, and the rows were the wrong way round ([eeb425e](https://github.com/jinhong-/paperloom/commit/eeb425e96fb95827b3120b7b1477aa339df2b784))
* turn the picture by half a turn, and give the setup screen room ([413af29](https://github.com/jinhong-/paperloom/commit/413af2967d44942a8e602c6d554e42ef35653492))


### Build

* give the server and the firmware a release of their own ([bfe5d07](https://github.com/jinhong-/paperloom/commit/bfe5d070f8e6997c517af48c3f0a921a4b85b7df))


### Chores

* keep fetched ESP-IDF components out of the repository ([ad8b7cf](https://github.com/jinhong-/paperloom/commit/ad8b7cf6ea7390a630375aba24a75fe372ae5bfc))
* stop tracking the ESP-IDF build output ([d53efee](https://github.com/jinhong-/paperloom/commit/d53efeebcfbc9c6aa8adfce918f6de202680d957))

## 0.1.0

The first release.

- The frame shows the pictures the server gives it, and keeps its own
  time so that it knows when to wake.
