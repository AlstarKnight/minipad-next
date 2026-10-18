# Android prototype (PR 1/4)

This is a deliberately small **local-only** Android prototype, separate from
the Windows application. It opens and edits the same `.md` note files using a
plain-text editor. The touch-friendly Milkdown editor and WebDAV are planned
for separate PRs; **this APK does not sync notes yet**.

## Build and try

Install Android Studio, Android SDK/NDK and Rust Android targets as described in
the [Tauri Android prerequisites](https://v2.tauri.app/start/prerequisites/).
Then, from the repository root:

```sh
npm ci
npm run android:init
npm run android:build
```

The last command builds a debug test APK for `aarch64` devices. Find it in
`src-tauri/gen/android/app/build/outputs/apk/` (or the Android CI artifact).
For local development, use `npm run tauri -- android dev`.

There is intentionally no Play Store release, signing-key setup or automatic
release in this PR. GitHub Actions runs the Android job only for relevant PRs or
manual dispatch.

## Current scope

- Choose a notebook and page, edit raw Markdown, view raw Markdown, and autosave.
- Add notebooks and pages without using desktop-only window commands.
- Store notes in the Android app-private data directory under `notes/`.
- Preserve the desktop `.md` and notebook directory layout. Saving uses the
  shared Rust collision-safe note writer and keeps conflict copies when its
  expected file version differs.
- The desktop entry point and Windows installer are unchanged.

**No WebDAV, media editor, image import, import/export, background sync, or
touch-rich Markdown UI yet.** Android-private app storage can be removed by
uninstalling the APK, so treat this stage as a test build and back up notes
manually before uninstalling.

## Planned follow-ups

1. **PR 2:** touch-sized notebook/page navigation and the Milkdown reading and
   editing UI, keyboard/IME tests, images and Android back handling.
2. **PR 3:** WebDAV settings, credential storage, remote list/download/upload,
   ETag checking and manual foreground sync, shared with Windows.
3. **PR 4:** tombstones/deletions, conflicts, retry/offline behavior, server
   compatibility matrix, Android test coverage and release documentation.

WebDAV work must not treat HTTP/network failure as a deletion or overwrite local
unsaved changes. A sync implementation is not complete until that can be
demonstrated by tests.
