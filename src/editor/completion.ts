// The editor's single `@codemirror/autocomplete` config. CM's `override` field
// is per-config, so two separate `autocompletion({override})` calls would clobber
// each other — every override source lives in ONE config here: emoji `:` and
// inline-tag `#`. (Hand-rolled floating menus — slash `/`, wikilink `[[`,
// template `{{` — are ViewPlugins composed separately and don't use this.)

import { autocompletion } from "@codemirror/autocomplete";
import { type Extension } from "@codemirror/state";
import { emojiCompletionSource } from "./emoji-complete";
import { tagCompletionSource } from "./tag-complete";

export function completionExtension(): Extension {
  return autocompletion({
    override: [emojiCompletionSource, tagCompletionSource],
    activateOnTyping: true,
    icons: false,
  });
}
