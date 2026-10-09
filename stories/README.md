# Myne design-system workbench

An in-repo, dev-only workbench over every component, screen and state in Myne's
shared `src/` tree, mounted from the **real** components with a fake Tauri host
(myne-md/myne#832, grown into a workbench by myne-md/myne#845).

It answers "which screen, which state, and what does it look like in dark mode
on hover" in one click instead of by driving individual screens, and it gives
reviews a coverage roster so no surface is missed.

## Run it

```bash
pnpm stories          # dev server on :1423 (desktop :1420, web :1421, mobile :1422)
pnpm stories:build    # static build in stories/dist/
pnpm stories:preview  # serve the built bundle
pnpm stories:test     # smoke (blocking) + drift (warning) render checks
pnpm stories:record   # re-record the DOM-hash baseline
```

Every story is addressable by URL: the fragment is the story id
(`#primitives/button/variants`), so a link can be pasted into an issue.

## The shell

- **Navbar.** The Myne mark, the wordmark and the version, with search in the
  centre, a **group filter** beside it, and **File issue**. It carries what
  changes what the catalogue *shows you*; the controls that change how the
  *stage* is drawn live in the review bar below (myne-md/myne#847).
  Search matches a story's id, its derived name, its state, its description and
  its tags, so "sync error" finds a story whose id says nothing about either. It
  **proposes** rather than filters: results appear as a listbox directly under
  the input, walked with the arrow keys and opened with Enter or a click. It
  deliberately does **not** touch the rail, because replacing the tree with a
  flat "matches" list loses the reader's place in the hierarchy; narrowing the
  rail is the filter's job, and the two controls answer two different questions.
  **File issue** opens the repo's `design-system.yml` issue form with the story,
  the state, the theme, the catalogue version and the page URL already filled in,
  so a finding arrives reproducible. The form field id and the query parameter
  are one contract: renaming either side silently drops the context.
- **Rail.** A tree: `group > component > [subcomponent] > Documentation | story`,
  reachable with the up and down arrows, which walk the flattened tree in the
  order the eye reads. States are leaves, so every story is an addressable node.
  A nesting comes from an optional hand-written `parent` on a descriptor, and
  only about thirty pairs in the tree have one; `scripts/check-story-tree.mjs`
  fails on a `parent` that names nothing, on a cycle, and on an edge with no
  import between the two modules in either direction (a settings shell imports
  its panels, while the shared modal shell is imported by its children, so one
  direction would reject half the real pairs). A name is derived from the
  component name and changes **casing only** (`ModalShell` reads as "Modal
  Shell"); `title` on a descriptor is the rare override. Title Case here is
  deliberate and is *not* a violation of the sentence-case rule that governs
  product copy: a rail entry is a **name in a list**, not a sentence. The two
  casings answer two different questions, and the Typography page states the
  split.
- **Stage.** The story, framed with padding by default. A surface that genuinely
  is full width (a screen, the editor) sets `fullBleed: true`. The active theme
  is named under the story so a screenshot is unambiguous.
- **Inspector.** Four tabs:
  - **Controls** switches between the current surface's states in place.
  - **Actions** logs what fired. A story passes `action("onClose")` rather than
    `noop`, so a control that fires is distinguishable from one that does not.
  - **Accessibility** shows the role and accessible name, the keyboard order, the
    target-size findings and the contrast failures, measured against the active
    theme, and it runs **axe-core** over the story with the results split into
    **Violations / Passes / Incomplete** the way a mature a11y panel does. The
    split matters because axe finds roughly 57% of WCAG issues, so `incomplete`
    is axe saying a human must look and hiding it would make the tab a worse
    reviewer than no tab. It is a per-story **view**: the gate is
    `tests/stories/a11yLevels.test.tsx`, and every story declares a level
    (`error` by default, `todo` to record a known finding, `off` with a reason).
  - **Interactions** forces `:hover`, `:focus-visible` and `:active`. A static
    mount cannot reach a pseudo-class, so this mirrors the matching rules onto a
    marker attribute. The UI says it is a forced state, because a screenshot of
    one must never be read as real.

## The review bar, and the URL contract

Above the stage, a second bar carries the controls that change how the stage is
drawn rather than what the story is: **direction** (LTR, RTL, or both side by
side from one fixture), a **viewport preset** (Fit, Mobile 390, Mobile 360,
Tablet 768, Desktop 1280, Wide 1440), **Measure**, **Outline**, **Fullscreen**,
**Reduced motion**, **Forced colors**, and the **theme**. Every one of them is
written into the URL, so a link reproduces the whole view (myne-md/myne#847).

- **The axes apply at view time and have no per-story opt-out.** Reduced motion
  and forced colors do not invent a policy: they **mirror** the matching media
  rules onto a marker attribute, so the axis shows a behaviour the app already
  has. A forced axis that mirrors zero rules warns rather than rendering as
  "nothing changed". The axis set is three, not five: compact density is a width
  to boolean function (`settingsCompact` over a `ResizeObserver`), so the
  viewport preset is what exercises it, and text scale is `editor_text_size`, the
  editor's own base size rather than a global mechanism.
- **`Fit` honours a story's own `viewport`**, and any other preset overrides it.
  A story pins a width only when it is narrow by nature.
- **Outline** draws containers and leaves in two colours. One colour is correct
  for a component-sized story and a wall of lines for the whole screens this
  catalogue mounts.
- **Measure** pins an element's box and the gaps to its neighbours. While it is
  on, the stage is inert, so a click can only measure and never fires the
  component's own handler. A measurement is not written to the URL: it is
  transient state, and a shared link to a measurement is a link to nothing.
- **Fullscreen** is a layout mode, not the Fullscreen API. The accessibility spec
  queries the story in the same document and the drift baseline hashes its DOM,
  so the story has to stay where it is. Escape leaves and a floating control
  returns, because a fullscreen with no visible way out is a trap.

### The theme

The theme dropdown offers the three built-in palettes (light, dark, amoled),
applied as `data-theme` on the document element, the same mechanism the clients
use, and the theme is part of the URL contract like every other view control.

A **shipped** theme (the ten in `myne-themes`) is deliberately not offered yet.
It needs a **committed snapshot** plus a guard that compares the snapshot to the
companion's index when the companion is present and reports what it could not
check when it is absent, because a build-time read of a companion repository
would make the catalogue's contents a function of which machine built it, which
breaks the property the URL contract exists to provide. That task was scoped and
then deferred (`myne-agents/features/design-system-coverage/tasks.md` task 11),
so the mechanism the two would share is not written down here until it exists.

## Foundations

The `foundations` group holds specimens for the token layer, the icons, type,
spacing, radii, shadows, motion, control metrics and the **layering ladder**.
They are **generated from their sources** (`client-core/src/tokens.css`, the icon
registry), read at build time with `?raw`, so a specimen cannot drift from what
ships and the catalogue needs no runtime fetch.

The `--z-*` ladder is new and worth knowing about: every step it names was
already a bare `z-index:` literal in the tree, and a bare literal cannot be read
, the order exists only by grepping for it, and the numbers lie about their
neighbours. The values are unchanged, so nothing restacks; the Z-index page
records the call sites still holding a bare number.

## Documentation pages

`documentation/design-system/*` is the narrative half: Typography, Colour,
Spacing, **Border Radius**, Elevation, **Z-index**, Motion, Iconography,
Accessibility Practice, **Story Definition of Done** and **Keeping This True**.
They embed the same specimens rather than re-rendering them, so a page cannot
show a different value from the specimen it is talking about.

Two of them are process rather than tokens:

- **Story Definition of Done** is the nine-item anatomy a story must answer
  before it counts as covering a surface, borrowed from the component-anatomy
  model a mature design system documents. It is also the measurable definition of
  the surfaces still in coverage debt.
- **Keeping This True** states the rule that keeps the whole thing from rotting:
  an audit follows a **symptom, not a calendar**, because anything a machine can
  judge is a guard rather than a checklist item. It also says out loud that a
  guard which has never failed is a guard nobody has tested.

## How it mounts the real app

`stories/src/host/internals.ts` installs a fake `window.__TAURI_INTERNALS__`
before any app module body runs, so the desktop platform seam (`src/platform/*`)
runs **unmodified** and every `invoke(cmd, args)` routes to canned fixture data.
This is the mechanism `mobile/tests/flow-logic/mock-ipc.ts` and the E2E page seat
already use. No app source changes, and no second UI codebase.

A story whose state only arrives from an event the catalogue cannot fire declares
`unreachable: { what, why }` and the stage renders the reason instead of a blank
box.

## Adding a story

1. Add an entry to a `stories/src/stories/*.tsx` file (or a new one) with `id`,
   `group`, `surface`, `state`, a `description`, at least one `tag`, an optional
   `fixture`, and `render`.
2. If it needs canned data, add a named fixture to `stories/fixtures/index.ts`.
3. `node scripts/check-story-coverage.mjs` fails until the new surface has a
   story, and `node scripts/check-story-catalogue.mjs` fails until the story has
   a description and tags, which is the point: both are ratchets.

After moving a module, regenerate the source reference the rail links to:

```bash
node scripts/gen-story-source-map.mjs   # writes stories/src/source-map.ts
```

## Deploying (the ops boundary)

`pnpm stories:build` produces a self-contained static SPA in `stories/dist/` that
any static server can serve. Standing it up (host, TLS, the deploy itself) is the
**ops task**; this repository owes a correct build and the guarantees below.

The site chrome (title, description, favicon and share card) lives in
`stories/index.html`. Absolute URLs come from **one** value the deploy fills in,
`VITE_STORIES_PUBLIC_ORIGIN`, so the build hardcodes no origin and a local build
stays origin-free.

**CSP note.** The catalogue renders Myne's real inline styles, so it needs
`style-src 'unsafe-inline'` (the same allowance the desktop WebView carries, for
the same reason: every design token is applied through inline `style`
attributes). It makes no network call, so `connect-src 'none'` is correct and
should be pinned. A reasonable policy:

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
connect-src 'none';
```

## The guards

| Guard | What it prevents | Where |
|---|---|---|
| `scripts/check-story-coverage.mjs` | a component or screen landing with no story | pre-commit + `pnpm-build` |
| `scripts/check-story-catalogue.mjs` | a story landing with no description or tags, or a story rendering a known placeholder phrase | pre-commit + `pnpm-build` |
| `scripts/check-story-tree.mjs` | a fabricated rail edge: a `parent` naming nothing, a cycle, or an edge with no import behind it in either direction | pre-commit + `pnpm-build` |
| `scripts/check-token-consumers.mjs` | a `--duration-*`, `--ease-*` or `--text-*` token the sheet declares that nothing outside the sheet reads. Those three families are the ones a catalogue can only *display*, so an unused one looks authoritative and changes no pixel | pre-commit + `pnpm-build` |
| `scripts/check-foundations-coverage.mjs` | a token landing with no specimen group. One direction only: it reads the sheet, not the catalogue, so a group deleted from `stories/src/foundations.tsx` is not caught and the guard's header says so | pre-commit + `pnpm-build` |
| `scripts/check-stories-isolation.mjs` | the catalogue entering an app bundle (an app build config or a Tauri bundle manifest referencing `stories/`) | pre-commit + `pnpm-build` |
| `scripts/check-stories-bundle.mjs` | an unrecorded origin, a BIP-39 word list (so no phrase can be shown or typed) or an account-number-shaped string in the served bundle | `stories-build` (CI) |
| `tests/stories/smoke.test.tsx` | a story that will not mount | `pnpm stories:test` (CI `vitest`) |
| `tests/stories/a11yLevels.test.tsx` | a story whose `a11y: "error"` level has an axe violation; also that axe actually ran on every story it did not skip | `pnpm stories:test` (CI `vitest`) |
| `tests/stories/shellSearch.test.tsx` | the shell's search and filter: that typing opens the suggestion panel, that it does NOT narrow the rail, that the filter is a labelled control, and that Escape closes the panel. The shell is not a story, so nothing else reached it | `pnpm stories:test` (CI `vitest`) |
| `tests/stories/axes.test.ts` | the URL contract: that every view key round-trips through parse and serialise, and that an unknown key is ignored rather than fatal | `pnpm stories:test` (CI `vitest`) |
| `tests/stories/type.test.ts`, `tests/stories/motion.test.ts` | the two things a page can only draw and a reader must take on trust: the `.t-*` role pairing read out of the component sheet, and the easing curve arithmetic (including the y-axis flip a hand-drawn curve gets wrong) | `pnpm stories:test` (CI `vitest`) |
| `tests/stories/drift.test.tsx` | an unintended rendering change (WARNING only) | `pnpm stories:test` (CI `vitest`) |

`stories/` is a guarded shared root in `scripts/lib/shared-roots.mjs`, so the
token, seam and i18n guards scan it like any other consumer of the shared tree.
The story host is the one file allowed to name the Tauri runtime global, the
same reasoned exemption `src/lib/app-window.ts` holds.

## Review pass (myne-md/myne#843)

Every registered story was mounted and reviewed against the canon, and each
finding is either fixed here or recorded with the reason it is not.

**Fixed.**

- **The catalogue could go completely blank.** `stories/vite.config.ts` defined
  `__APP_VERSION__` and `__BUILD_COMMIT__` but not `__UPDATE_CHANNEL__`, which
  `AboutPanel` reads during render. Selecting `settings/aboutpanel/default`
  threw `ReferenceError`, and with no boundary in the shell it unmounted every
  story at once. The third global is now defined in both the catalogue's Vite
  config and `vitest.stories.config.ts` (whose smoke check hit the same throw),
  and `stories/src/ErrorBoundary.tsx` wraps each story so one failure renders a
  message in place of that story instead of taking the rail down with it.
- **Three modal backdrops bypassed the scrim token.** `CommandPalette`,
  `QuickPicker` and `promptForText` hardcoded `rgba(0, 0, 0, 0.32)`, which
  neither matched `--scrim` nor followed the theme. They now use `var(--scrim)`,
  the token `ModalShell` already reads. `check-token-adoption` recorded three
  fewer literals.
- **`settings/syncpanel/default` rendered `NaN KiB of NaN KiB`.** The fixture
  answered no `sync_account_status`, so the fake host's `{}` default reached
  `SyncUsageBlock`. Not enrolled means the block is absent, so the fixture now
  answers `null` and supplies an empty device list.
- **`MemberVaultUnlockCard` printed one sentence twice.** The intro paragraph and
  the phrase field's `hint` were both `unlock.memberHint`; the field hint is now
  the shared `sync.enroll.recoveryPhraseHint`.
- **`ai-panel/chat` showed the "compiled without local AI" state.** The fixture
  set `ai_enabled` but answered no `ai_capability_report`, so the capability gate
  read it as uncompiled. Its handler is now present, and the story shows the chat
  it describes (the same story a user-guide screenshot is taken from).

**Reviewed, not a defect.**

- Controls below 24px (`Switch` at 36×20, several 20px icon buttons) pass axe's
  `target-size` through its spacing exception; the `--target-min` work is
  myne-md/myne#728's, not this pass's.
- Hardcoded colours in `AppearancePanel` are theme-swatch and accent-preset
  data, which a single token cannot express.
- The disabled "Save" label's 2.32 contrast is a disabled control, which WCAG
  exempts.

## Workbench pass (myne-md/myne#845)

The pass that grew the catalogue into a workbench. Most of it is the shell
(navbar search, collapsible inspector, theme dropdown, the doc pages), but the
new gates found real defects in the product on their first run, and every one is
fixed here.

**Found by the gates, fixed in this change.**

- **A password field with no accessible name.** `PasswordInput` rendered its
  label as a `<label>` with no `htmlFor`, in a different row from the `<input>`,
  so the two were never associated. Every password field in every flow. Create,
  change, recover, sync-enroll, migrate. Announced as a bare "password, edit
  text", and a screen-reader user could not tell the password field from the
  confirm field. One `useId` associates them. Found by the new axe gate; it had
  never been caught because the a11y suites assert the components they name and
  nobody had named this one.
- **A `role="switch"` with no `aria-checked`.** Nine settings panels read a value
  their story fixture did not answer, so the fake host's benign `[]` default
  reached `checked` and React rendered `aria-checked=""` (or omitted it). The
  fixture now answers `plugin:update|update_get_auto_check` with the boolean the
  real command returns, and `DEFAULT_PREFS` gained the four fields it was missing
  from `PrefsView::default()`. The nine stories that still resolve a value late
  carry `a11y: "todo"` and name the reason.
- **`var(--space-10)`, which the token sheet does not have and never had.** Two
  catalogue pages asked for it, so their `max-width` was simply not applied and
  they ran the full stage width while reading as an intentional flat layout. It
  was caught by `check-token-parity`. A guard this branch had not run. And the
  fix is the token that was actually meant: `--content-max-w`, a **size** rather
  than a spacing step, since the scale is the layout *between* things.
- **A bare `aria-label` on a `<div>`.** `PairingDialog`'s challenge code carried
  one, which is prohibited on a generic element: the name was ignored, so the
  code the user is asked to compare had no label at all. `role="group"` is the
  role that may carry a name.
- **A form control inside `SettingRow` has no accessible name.** The row renders
  its label as a `<span>`, so a number input inside one announced as a bare
  number field. Named locally on the retention input; associating every row
  control is the row's own change and is recorded as debt rather than
  half-done.
- **`role="listitem"` rows with no list parent** in the `CustomizeList` demo. Both
  real callers put `role="list"` on the container and the demo did not, so the
  story showed a shape the app never renders.
- **An axe hang, not a failure.** The Accessibility tab's first version sat on
  "running axe" forever with no error and no rejection. Two causes stacked:
  axe-core ships CommonJS with no `default` key, so the default import was
  `undefined`; and once past that, React 19's StrictMode invokes the effect
  twice, so two `axe.run()` calls hit axe-core's single global audit at once and
  deadlocked. The runs are now serialized and a rejection is logged rather than
  swallowed. A silent hang is the worst shape because nothing reports it.
