# Load-bearing: tauri instantiates the plugin class and dispatches @Command
# methods BY REFLECTION (PluginManager.load / dispatchPluginMessage), and
# tauri's own proguard rules only keep TauriActivity.getPluginManager — a
# minified (R8) app build would otherwise strip or rename this module and
# silently drop every reminder registration in release builds.
-keep @app.tauri.annotation.TauriPlugin class * { *; }
-keep class md.myne.reminders.** { *; }
