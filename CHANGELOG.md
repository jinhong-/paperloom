# Changelog

## [0.3.1](https://github.com/jinhong-/paperloom/compare/paperloom-v0.3.0...paperloom-v0.3.1) (2026-11-15)


### Bug Fixes

* the add-on's data directory in the image ([52576aa](https://github.com/jinhong-/paperloom/commit/52576aa5fb4311990a4ae94525f2cad73337dd28))
* **web:** reach the server through Home Assistant's path prefix ([576011d](https://github.com/jinhong-/paperloom/commit/576011d88ee396268d7ffa15eeb0242ef79f2694))

## [0.3.0](https://github.com/jinhong-/paperloom/compare/paperloom-v0.2.0...paperloom-v0.3.0) (2026-11-15)


### Features

* a frame shows one gallery, and a gallery says when it changes ([078d1b7](https://github.com/jinhong-/paperloom/commit/078d1b7479d21cd80e325abfca0ef91bf26231cf))
* a frame shows one gallery, and a gallery says when it changes ([#7](https://github.com/jinhong-/paperloom/issues/7)) ([078d1b7](https://github.com/jinhong-/paperloom/commit/078d1b7479d21cd80e325abfca0ef91bf26231cf))
* a gallery says when it changes, and how its pictures look ([980e3ca](https://github.com/jinhong-/paperloom/commit/980e3ca694123fb6e5b50f44bd1cf8e30a30df73))
* a gallery says when it changes, and how its pictures look ([#6](https://github.com/jinhong-/paperloom/issues/6)) ([980e3ca](https://github.com/jinhong-/paperloom/commit/980e3ca694123fb6e5b50f44bd1cf8e30a30df73))
* **server, web:** file the pictures sent to a Telegram bot into a gallery ([8823183](https://github.com/jinhong-/paperloom/commit/88231836ca9119cb06977f64a025f78c66b408dd))
* show a picture next, and keep more of them on the frame ([1dbd5bf](https://github.com/jinhong-/paperloom/commit/1dbd5bf82b29168c7e664e1c294ca7c0c9de3f00))
* show a picture next, and keep more of them on the frame ([#8](https://github.com/jinhong-/paperloom/issues/8)) ([1dbd5bf](https://github.com/jinhong-/paperloom/commit/1dbd5bf82b29168c7e664e1c294ca7c0c9de3f00))
* **telegram:** authorise the people who send pictures, one by one ([7210afc](https://github.com/jinhong-/paperloom/commit/7210afc2fe1681a5505aff416a105bf860ede8a3))
* **telegram:** slot a picture from a chat into the frame's next check-in ([2b77235](https://github.com/jinhong-/paperloom/commit/2b7723532ac89db7a43b51365560b1799d628759))
* **web:** a setup page for the first account ([#3](https://github.com/jinhong-/paperloom/issues/3)) ([11bb0a4](https://github.com/jinhong-/paperloom/commit/11bb0a4aa59b8989c1d9c8ea77e88ed85a93b72d))


### Bug Fixes

* give the frame a picture at once, and recover from a refused clock ([120cb6e](https://github.com/jinhong-/paperloom/commit/120cb6e5646aa368b4b5eee3311778c91f2784a0))
* give the frame the whole plan, so that it and the server agree ([e3508fc](https://github.com/jinhong-/paperloom/commit/e3508fc0efc3410f1662e92a52e481bda6370267))
* keep the schedule stable, and extend it rather than replace it ([6a002b7](https://github.com/jinhong-/paperloom/commit/6a002b7d34d2e98d20f6baac15c5431e346bea1d))
* plan the photos at least as far apart as the frame checks in ([d3b3d99](https://github.com/jinhong-/paperloom/commit/d3b3d99c59a0530d81a4a4b18be98a42808abee3))
* round the schedule to the minute, and keep the clock honest ([de5be6f](https://github.com/jinhong-/paperloom/commit/de5be6f26c8310df8ae4181bf633adde3b3f7a02))
* **telegram:** show a person who says hello, not only one who sends a picture ([1766a1c](https://github.com/jinhong-/paperloom/commit/1766a1cdcd251fc961906a0fbe3ee78887d13ec4))
* the frame asks the server for the time when it has lost its power ([078d1b7](https://github.com/jinhong-/paperloom/commit/078d1b7479d21cd80e325abfca0ef91bf26231cf))
* the plan reaches the next check-in plus the lookahead ([d5e9d8e](https://github.com/jinhong-/paperloom/commit/d5e9d8e6cfec38449bf2649ce86be73d7aa034a9))


### Firmware

* do not turn the picture on its way to the panel ([2603304](https://github.com/jinhong-/paperloom/commit/2603304119df17e3bb0b7e98b9c47c8e23e03c8e))


### Build

* keep the add-on's version with the server's ([d82ffe3](https://github.com/jinhong-/paperloom/commit/d82ffe37d87921a999b2368160976e6643e0fbc1))


### Documentation

* describe the conventions for agents working in this repository ([b8b0799](https://github.com/jinhong-/paperloom/commit/b8b0799134265cb2bd120235129cebd67941b0e5))


### Continuous Integration

* add pull request checks ([dd5849d](https://github.com/jinhong-/paperloom/commit/dd5849dabed853ccc21c200941e36e9680b96c54))
* check conventional pull request titles locally ([ef3403d](https://github.com/jinhong-/paperloom/commit/ef3403df31eaeee97376bfca16f540ed1c5681ba))
* scope Release Please to the web app ([fa94936](https://github.com/jinhong-/paperloom/commit/fa94936998bb8e4c7f88dc98b9a6b7457002b9f9))


### Chores

* **main:** release paperloom-web 0.2.0 ([#2](https://github.com/jinhong-/paperloom/issues/2)) ([a515b08](https://github.com/jinhong-/paperloom/commit/a515b08e227acf218417adeac2a7baf8fdfcb09b))
* **main:** release paperloom-web 0.3.0 ([#5](https://github.com/jinhong-/paperloom/issues/5)) ([a7da829](https://github.com/jinhong-/paperloom/commit/a7da82935d388eebe8ee9ad5c054e5e52a02fbb7))

## [0.2.0](https://github.com/jinhong-/paperloom/compare/paperloom-v0.1.0...paperloom-v0.2.0) (2026-11-14)


### Features

* add Home Assistant add-on packaging ([275fa49](https://github.com/jinhong-/paperloom/commit/275fa49bb555f36f9f0ed5bd84b18d6dc612edf6))
* publish a self-contained Home Assistant release branch ([34bcfab](https://github.com/jinhong-/paperloom/commit/34bcfabd11145a8d2137e928e1ae1a7d55169662))


### Bug Fixes

* build the Home Assistant app from its own directory ([47e5ac0](https://github.com/jinhong-/paperloom/commit/47e5ac06c4556f6f26593ef6730907988bcacaf4))
* publish the Home Assistant branch from main changes ([21c55d4](https://github.com/jinhong-/paperloom/commit/21c55d48746b738526753c14b143e9b63363c612))
* put add-on repository metadata at repository root ([ece38d9](https://github.com/jinhong-/paperloom/commit/ece38d9a5009b13c00ebff7b7694ecc710874fd4))
* use the exact GHCR package owner path ([994d575](https://github.com/jinhong-/paperloom/commit/994d575175135f686a166eb24b5afc8d2903ddeb))
