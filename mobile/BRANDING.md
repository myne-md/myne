# Brand assets

The Myne brand assets in this app — the app icon (`src-tauri/icons/`), the widget marks
(`android-widgets/.../myne_mark.xml`, `ios-widgets/.../MyneMark.swift`), and
`.github/banner.png` — render the Myne mark, which is canonically defined in the brand
repository, [`myne-branding`](https://github.com/myne-md/myne-branding).

These renderings are **build-locked** here (the Tauri bundler and the native widget
targets need them in-tree), so they are **not** removed — but the **canonical source is
`myne-branding`** (`logo/` + `app-icon/`). When the brand mark changes there, update
these platform renderings to match. Each client keeps the app-icon master its build
needs; `myne-branding` holds the canonical mark and the press exports.

Brand marks are trademarks; their use is governed by the `myne-branding` repo's
[`TRADEMARK.md`](https://github.com/myne-md/myne-branding/blob/main/TRADEMARK.md).
