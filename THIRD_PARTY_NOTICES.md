# Third-party notices

hinge bundles binaries it does not build itself. Their sources and licences
are listed here.

## scrcpy-server

`vendor/scrcpy-server-v4.1` (fetched by `npm run fetch-vendor`, packaged as
`resources/vendor/scrcpy-server-v4.1`) is built from
[scrcpy](https://github.com/Genymobile/scrcpy) v4.1, unmodified. The full
licence text ships alongside it in every packaged build as
[LICENSE-scrcpy](LICENSE-scrcpy), packaged at `resources/LICENSE-scrcpy`.

```
Copyright (C) 2018 Genymobile
Copyright (C) 2018-2026 Romain Vimont

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Android platform-tools (adb)

`vendor/platform-tools-win` and `vendor/platform-tools-linux` (fetched by
`npm run fetch-vendor`, packaged as `resources/vendor/platform-tools-<os>`)
are built from the Android SDK platform-tools, r37.0.1, from
`https://dl.google.com/android/repository/`. Their own licence and copyright
notice is bundled alongside them as `NOTICE.txt` and ships in every packaged
build at `resources/vendor/platform-tools-<os>/NOTICE.txt`.
