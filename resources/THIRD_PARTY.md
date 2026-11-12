# Third-party components

## Everything SDK

The unmodified x64 Everything SDK DLL by voidtools is included in `everything/Everything64.dll`. The MIT license is included in `everything/LICENSE.txt`. SDK project: https://www.voidtools.com/support/everything/sdk/ . The accompanying `EverythingSearch.cs` / `.exe` is Mini Manga's separate read-only IPC client; it requires an existing running Everything instance and does not install, reconfigure or redistribute the Everything application.

Mini Manga invokes the unmodified official 7-Zip 26.05 command-line executable as a separate process. Copyright (C) Igor Pavlov. Its LGPL/BSD/unRAR terms are included in 7zip/License.txt; full LGPL text is included alongside it. Source: https://github.com/ip7z/7zip/releases/tag/26.05 . The optional modified 7zc binaries are not used.

The 7zip-bin-full package is a development-time binary supplier; its wrapper license does not replace the 7-Zip binary license.

parse5 7.3.0 parses online HTML as data under the MIT license. Its dependency entities retains its BSD-2-Clause license. Both packages ship with their original license files.

Electron, React, TanStack, Zustand, Zod, sharp and its libvips dependencies retain their respective licenses. Dependency license notices are distributed with those dependencies. sharp source: https://github.com/lovell/sharp ; libvips source: https://github.com/libvips/libvips .

## PDF rendering

PDF.js (`pdfjs-dist` 6.4.299) is used to parse PDF documents and render pages in a dedicated Worker. It is licensed under Apache License 2.0. Source: https://github.com/mozilla/pdf.js ; project: https://mozilla.github.io/pdf.js/ . The package's LICENSE and associated notices remain with the distributed dependency.

`@napi-rs/canvas` 1.0.13 provides the native canvas implementation used for PDF page rendering. It is licensed under MIT. Source: https://github.com/Brooooooklyn/canvas . Its package and platform-native dependency retain their license files and bundled third-party notices, including those of the underlying graphics components.

These version numbers identify the versions verified for Mini Manga 0.2.0. See `package-lock.json` for the exact dependency resolution. The descriptions here do not replace the full license texts distributed with the dependencies.
