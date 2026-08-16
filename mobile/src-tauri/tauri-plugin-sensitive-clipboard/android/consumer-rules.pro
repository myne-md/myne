# R8 keep rules for the sensitive-clipboard plugin.
#
# The package rule is the load-bearing one, and it is not decoration copied from
# a sibling. `invoke.parseArgs(WriteArgs::class.java)` binds by REFLECTION over
# field names, so under a minified consuming app build R8 is free to rename
# `value`, `sensitivity` and `expireAfterSecs`. If `sensitivity` fails to bind it
# falls back to its Kotlin default, and a `write_secret` becomes an ordinary
# write: no sensitivity extra, no scheduled clear, on a release build only.
#
# The `@TauriPlugin` rule below covers the plugin CLASS. It does not cover the
# `@InvokeArg` classes, which carry no annotation of their own — which is exactly
# why each sibling keeps its whole package rather than relying on the annotation.
-keep class md.myne.mobile.sensitiveclipboard.** { *; }
-keep @app.tauri.annotation.TauriPlugin class * { *; }
