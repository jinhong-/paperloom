# Changelog

## [0.2.0](https://github.com/jinhong-/paperloom/compare/paperloom-server-v0.1.0...paperloom-server-v0.2.0) (2026-11-15)


### Features

* a frame shows one gallery, and a gallery says when it changes ([078d1b7](https://github.com/jinhong-/paperloom/commit/078d1b7479d21cd80e325abfca0ef91bf26231cf))
* a frame shows one gallery, and a gallery says when it changes ([#7](https://github.com/jinhong-/paperloom/issues/7)) ([078d1b7](https://github.com/jinhong-/paperloom/commit/078d1b7479d21cd80e325abfca0ef91bf26231cf))
* a gallery says when it changes, and how its pictures look ([980e3ca](https://github.com/jinhong-/paperloom/commit/980e3ca694123fb6e5b50f44bd1cf8e30a30df73))
* a gallery says when it changes, and how its pictures look ([#6](https://github.com/jinhong-/paperloom/issues/6)) ([980e3ca](https://github.com/jinhong-/paperloom/commit/980e3ca694123fb6e5b50f44bd1cf8e30a30df73))
* add Home Assistant add-on packaging ([275fa49](https://github.com/jinhong-/paperloom/commit/275fa49bb555f36f9f0ed5bd84b18d6dc612edf6))
* **server, web:** file the pictures sent to a Telegram bot into a gallery ([8823183](https://github.com/jinhong-/paperloom/commit/88231836ca9119cb06977f64a025f78c66b408dd))
* show a picture next, and keep more of them on the frame ([1dbd5bf](https://github.com/jinhong-/paperloom/commit/1dbd5bf82b29168c7e664e1c294ca7c0c9de3f00))
* show a picture next, and keep more of them on the frame ([#8](https://github.com/jinhong-/paperloom/issues/8)) ([1dbd5bf](https://github.com/jinhong-/paperloom/commit/1dbd5bf82b29168c7e664e1c294ca7c0c9de3f00))
* **telegram:** authorise the people who send pictures, one by one ([7210afc](https://github.com/jinhong-/paperloom/commit/7210afc2fe1681a5505aff416a105bf860ede8a3))
* **telegram:** slot a picture from a chat into the frame's next check-in ([2b77235](https://github.com/jinhong-/paperloom/commit/2b7723532ac89db7a43b51365560b1799d628759))
* **web:** a setup page for the first account ([#3](https://github.com/jinhong-/paperloom/issues/3)) ([11bb0a4](https://github.com/jinhong-/paperloom/commit/11bb0a4aa59b8989c1d9c8ea77e88ed85a93b72d))


### Bug Fixes

* a frame waiting to be claimed can be found and claimed ([f6b104d](https://github.com/jinhong-/paperloom/commit/f6b104d5fafe9bae4c626de4064607cc300886a8))
* a picture asked for is not missed by the frame ([397ae76](https://github.com/jinhong-/paperloom/commit/397ae7610e66f3f023e45fe1569c32151d5e314e))
* give the frame a picture at once, and recover from a refused clock ([120cb6e](https://github.com/jinhong-/paperloom/commit/120cb6e5646aa368b4b5eee3311778c91f2784a0))
* give the frame the whole plan, so that it and the server agree ([e3508fc](https://github.com/jinhong-/paperloom/commit/e3508fc0efc3410f1662e92a52e481bda6370267))
* keep the schedule stable, and extend it rather than replace it ([6a002b7](https://github.com/jinhong-/paperloom/commit/6a002b7d34d2e98d20f6baac15c5431e346bea1d))
* plan the photos at least as far apart as the frame checks in ([d3b3d99](https://github.com/jinhong-/paperloom/commit/d3b3d99c59a0530d81a4a4b18be98a42808abee3))
* round the schedule to the minute, and keep the clock honest ([de5be6f](https://github.com/jinhong-/paperloom/commit/de5be6f26c8310df8ae4181bf633adde3b3f7a02))
* **telegram:** show a person who says hello, not only one who sends a picture ([1766a1c](https://github.com/jinhong-/paperloom/commit/1766a1cdcd251fc961906a0fbe3ee78887d13ec4))
* the frame asks the server for the time when it has lost its power ([078d1b7](https://github.com/jinhong-/paperloom/commit/078d1b7479d21cd80e325abfca0ef91bf26231cf))
* the plan reaches the next check-in plus the lookahead ([d5e9d8e](https://github.com/jinhong-/paperloom/commit/d5e9d8e6cfec38449bf2649ce86be73d7aa034a9))


### Server

* check-in rules, a time zone picker, and photo previews ([83dbba4](https://github.com/jinhong-/paperloom/commit/83dbba4b9d5f8b16ba798554dfaea81266023dc7))
* check-in rules, a time zone picker, and photo previews ([e0c13c6](https://github.com/jinhong-/paperloom/commit/e0c13c6b9e9d9b0091a361e3d9cccf9ecee47ade))
* make a fresh clone produce a working server ([0bc780e](https://github.com/jinhong-/paperloom/commit/0bc780e6d2df31505db55fce11eda59c4a50bd74))
* Paperloom server skeleton ([92b302d](https://github.com/jinhong-/paperloom/commit/92b302d104180e4b50422263c42b98836e07c30e))
* rebuild a schedule when the device's inputs change ([8739a7c](https://github.com/jinhong-/paperloom/commit/8739a7c9b8b2d115feeeda89616bb8474e8a3e68))
* the rules a frame starts with, and only the schedule that is coming ([4bed691](https://github.com/jinhong-/paperloom/commit/4bed691069ac9cf2b0b6b2b2e41c1cbe83bea84f))
* web UI, device simulator and full-stack integration test ([b2499fa](https://github.com/jinhong-/paperloom/commit/b2499fa67a657f12574c1c70f17be11c4879efde))


### Firmware

* a signed sync that the server accepts ([24bd8a0](https://github.com/jinhong-/paperloom/commit/24bd8a056327f32d6415acf00307172647c8904a))
* the setup flow, and a working request path ([0933bd5](https://github.com/jinhong-/paperloom/commit/0933bd59c376d9c79db6e545a9dbcdc568a56e5b))
* the text glyphs were mirrored ([17b21b1](https://github.com/jinhong-/paperloom/commit/17b21b1d267c1fe333ad53711ae93484eb4cee43))
* the text was upside down, and the rows were the wrong way round ([eeb425e](https://github.com/jinhong-/paperloom/commit/eeb425e96fb95827b3120b7b1477aa339df2b784))


### Build

* give the server and the firmware a release of their own ([bfe5d07](https://github.com/jinhong-/paperloom/commit/bfe5d070f8e6997c517af48c3f0a921a4b85b7df))


### Documentation

* project README and development tooling ([44a18d0](https://github.com/jinhong-/paperloom/commit/44a18d0e8af84cc50367a18e4a58d8afc4d640bf))

## 0.1.0

The first release.

- The server owns the galleries, the scheduling policy, the rendering of
  the pictures for the panel, and the API the frames talk to.
