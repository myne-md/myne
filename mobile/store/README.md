# store/ — App Store / Google Play listing screenshots

**Not app code.** Nothing here is bundled into the binary. These are the artefacts you upload to
App Store Connect / Google Play Console. The folder is **self-contained**: fonts and the brand
mark are vendored under `src/`, so generating the set reads and writes nothing outside `store/`.

- `6.9/` — the required App Store 6.9" set (1320×2868, iPhone 16/17 Pro Max @3x). Google Play
  accepts these same PNGs (2:4.34 portrait is within its phone range).
- `src/` — what generates it. Run `./generate.sh` (needs Google Chrome + ImageMagick 7).

## Why the set is built, not captured

An honest capture needs an unlocked vault with representative notes, which no script has (and
shipping a real note into a store image is a privacy leak). So `src/` redraws the screens from
Myne's own tokens — every colour, radius, spacing step and type size in `src/screen.css` is the
value from `docs/design/colors_and_type.css` (warm-paper `#fbfbfa`, ink `#1a1a17`, iron-blue
`#2c4a7a`, the 4px spacing scale, Inter + JetBrains Mono). **Nothing enforces that link but this
note:** if a token changes, change it here too, or the store slowly stops looking like the app.

## Why it is one image, sliced

The five frames are cut from a single 6600×2868 canvas rendered in one Chrome pass, so the solid
backdrop, the mark watermark and the cards parked on the seams line up exactly. Rendering five
images separately and hoping they match is how you get a panorama with visible joins.

The discipline that makes a panorama work: **each frame must still sell on its own.** Most people
never scroll past the first two, so frame 1 carries the strongest claim and the continuity is
decoration — if a viewer never completes the picture, they lose nothing but a flourish.

## Brand discipline (PRODUCT.md)

Myne is privacy-first, not a privacy product as theme. The set honours the anti-patterns:

- **Solid surfaces only.** No gradient backgrounds, no glass/blur/vibrancy. The backdrop is one
  flat colour; emphasis comes from weight and size, not from a glow.
- **No lock / shield / green-checkmark badges.** Encryption is communicated *typographically* —
  through the monospace account-number (`MY-XXXX-XXXX-XXXX-XXXX-XXXX`) and 24-word recovery-phrase
  specimens, not a padlock sticker.
- **Sentence case, no hype words, no emoji, no exclamation points.** Captions stay literal
  ("end-to-end encrypted markdown", "24-word recovery phrase") and never exceed a claim the
  threat model backs.
- Lucide stroke icons only, `currentColor`.

## What is deliberately not shown

Content is synthetic and generic — no real note, no real account number, no real address. The set
depicts only shipped mobile surfaces, so nothing in front of a reviewer is a stub or a promise.

## Regenerating

```bash
./store/generate.sh
```

Chrome renders `src/panorama.html` (written by `src/build.js`, which pulls the in-phone UI from
`src/screens.js` + `src/screen.css`), then ImageMagick slices and strips it into `6.9/`. Re-running
with no source change is a pixel no-op (`-strip` drops the timestamp chunk), so the git diff stays
meaningful.
