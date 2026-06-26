// Vitest global setup — initialise the shared i18n instance before any
// component test renders. Components that call `useTranslation()` (Welcome,
// Unlock, the Settings panels) need the global react-i18next instance to
// exist; importing the app's i18n module for its side effect provides it, so
// `t(...)` returns the real English source strings in tests (matching what
// production renders in the default locale). `detectInitialLanguage` runs in
// the node/jsdom test host with no stored override → it resolves to English.

import "../src/i18n";
