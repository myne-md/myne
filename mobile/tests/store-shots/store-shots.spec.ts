// The browser half of the store-image capture. NOT a test suite: it asserts
// nothing about product behaviour, it writes PNGs, and it is invoked by
// `scripts/shot-store-images.mjs`, never by `pnpm test:flow`.
//
// It is deliberately dumb. The plan (which sets, which frames, which screens,
// which captions, which geometry, which palette) is computed in
// `scripts/lib/store-shots/` and arrives as JSON through `STORE_PLAN_FILE`, so
// this file makes exactly two decisions of its own: which board toggle to click,
// and how to lay the canvas out and photograph it.
//
// ONE CANVAS, SLID AND CLIPPED. The plate, the ruled ground, the cipher field and
// every floating card are drawn ONCE across the full width of the set, and each frame is captured by
// translating the canvas so that frame sits at the viewport origin and clipping
// one frame's box. Drawing per frame and hoping the seams line up is how a
// panorama gets joins in it. Sliding a fixed canvas rather than widening the
// viewport is deliberate too: the board's layout reacts to viewport width, so a
// canvas eight frames wide would change what the board renders underneath it.
//
// THE PLATFORM TOGGLE HAS TO BE CLICKED FIRST, because the board renders the
// CURRENT platform's device frame: one screen exists once, inside whichever
// chrome the toggle selects. So capturing an Android set means asking the board
// for Android chrome, never recolouring an iOS frame, which is exactly how the
// Android slot came to hold iPhone screenshots in the first place.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  plateGeometry,
  canvasGeometry,
  graphicLayout,
  cardLayout,
  cipherField,
  cipherSegments,
  glowFor,
  bannerEdge,
  bannerCellPath,
  BANNER_COLOURS,
  CARD_GLYPHS,
  PLATE_PALETTE,
} from "../../../scripts/lib/store-shots/compose.mjs";
import { assertScreensPresent } from "../../../scripts/lib/store-shots/story.mjs";

const planPath = process.env.STORE_PLAN_FILE;
if (!planPath) {
  throw new Error(
    "STORE_PLAN_FILE is not set. Run the capture through scripts/shot-store-images.mjs; " +
      "invoking this lane directly has no plan to execute.",
  );
}
const plan = JSON.parse(readFileSync(planPath, "utf8"));

/** Card icon tiles. Iron plus neutrals: colour without leaving the palette. */
const CARD_ACCENTS = ["#2c4a7a", "#1a1a17", "#3a3934", "#6b6a64"];

const deviceSlots = plan.slots.filter((s: { slot: { layout?: string } }) => s.slot.layout !== "graphic");
const graphicSlots = plan.slots.filter((s: { slot: { layout?: string } }) => s.slot.layout === "graphic");

for (const entry of graphicSlots) {
  test(`capture ${entry.slot.id}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({
      viewport: entry.slot.viewport,
      deviceScaleFactor: entry.slot.scale,
    });
    const page = await context.newPage();
    await page.goto(`${baseURL}/?gallery`, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-screen]", { timeout: 90_000 });
    await page.locator(`button:has-text("${entry.toggle}")`).first().click();
    await page.waitForTimeout(300);

    const frame = entry.frames[0];
    const box = await page.evaluate((screenId) => {
      const card = document.querySelector(`[data-screen="${screenId}"]`);
      const holder = card?.lastElementChild as HTMLElement | null;
      if (!holder) return null;
      const r = holder.getBoundingClientRect();
      return { width: r.width, height: r.height };
    }, frame.screenId);
    expect(box, `graphic wants screen "${frame.screenId}"`).not.toBeNull();

    const g = graphicLayout(entry.slot, box as { width: number; height: number });

    await page.evaluate(
      (payload) => {
        document.getElementById("store-canvas")?.remove();
        const { g: geom, frame: f, palette } = payload;

        const root = document.createElement("div");
        root.id = "store-canvas";
        root.style.cssText = [
          "position:fixed",
          "left:0",
          "top:0",
          `width:${geom.plate.width}px`,
          `height:${geom.plate.height}px`,
          `background-color:${palette.background}`,
          "overflow:hidden",
          "z-index:2147483647",
          "font-family:var(--font-sans)",
        ].join(";");

        const card = document.querySelector(`[data-screen="${f.screenId}"]`);
        const device = card?.lastElementChild as HTMLElement | null;
        if (!device) throw new Error(`no device frame inside ${f.screenId}`);

        const cap = document.createElement("div");
        cap.style.cssText = [
          "position:absolute",
          `left:${geom.caption.left}px`,
          `top:${geom.caption.top}px`,
          `width:${geom.caption.width}px`,
        ].join(";");
        const headline = document.createElement("div");
        headline.textContent = f.caption.headline;
        headline.style.cssText = [
          `font-size:${geom.caption.headlineSize}px`,
          "font-weight:700",
          "line-height:1.16",
          "letter-spacing:-0.02em",
          `color:${palette.ink}`,
        ].join(";");
        cap.append(headline);

        const holder = document.createElement("div");
        holder.style.cssText = [
          "position:absolute",
          `left:${geom.device.left}px`,
          `top:${geom.device.top}px`,
          `width:${f.box.width}px`,
          `height:${f.box.height}px`,
          `transform:scale(${geom.device.scale})`,
          "transform-origin:top left",
        ].join(";");
        holder.append(device.cloneNode(true));

        root.append(cap, holder);
        document.body.append(root);
        window.scrollTo(0, 0);
      },
      {
        g,
        palette: PLATE_PALETTE,
        frame: { screenId: frame.screenId, caption: frame.caption, box },
      },
    );

    await page.screenshot({
      path: `${frame.out}/${frame.filename}`,
      clip: { x: 0, y: 0, width: entry.slot.viewport.width, height: entry.slot.viewport.height },
    });

    await page.evaluate(() => document.getElementById("store-canvas")?.remove());
    await context.close();
  });
}

for (const entry of deviceSlots) {
  test(`capture ${entry.slot.id}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({
      viewport: entry.slot.viewport,
      deviceScaleFactor: entry.slot.scale,
    });
    const page = await context.newPage();

    const problems: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

    await page.goto(`${baseURL}/?gallery`, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-screen]", { timeout: 90_000 });

    await page.locator(`button:has-text("${entry.toggle}")`).first().click();
    await page.waitForTimeout(300);
    await page.waitForSelector("[data-screen]", { timeout: 30_000 });

    const boardIds: string[] = await page.evaluate(() =>
      [...document.querySelectorAll("[data-screen]")].map((el) => el.getAttribute("data-screen") ?? ""),
    );

    // Fails BY NAME, before a single plate is composed, when a frame the plan
    // names is not something the board renders.
    assertScreensPresent(entry.frames, boardIds);

    const canvas = canvasGeometry(entry.slot, entry.frames.length);
    const cipher = cipherField(entry.slot, entry.frames.length);
    const cipherSegs = cipherSegments(entry.slot, entry.frames.length).segments;
    const edge = bannerEdge(entry.slot, entry.frames.length);

    const boxes: { width: number; height: number }[] = [];
    for (const frame of entry.frames) {
      const box = await page.evaluate((screenId) => {
        const card = document.querySelector(`[data-screen="${screenId}"]`);
        const holder = card?.lastElementChild as HTMLElement | null;
        if (!holder) return null;
        const r = holder.getBoundingClientRect();
        return { width: r.width, height: r.height };
      }, frame.screenId);
      expect(box, `frame "${frame.id}" wants screen "${frame.screenId}"`).not.toBeNull();
      boxes.push(box as { width: number; height: number });
    }

    await page.evaluate(
      (payload) => {
        document.getElementById("store-canvas")?.remove();
        const { canvas: c, cipherSegs, edge, frames, palette, bannerColours, cardGlyphs, cardAccents } = payload;

        const root = document.createElement("div");
        root.id = "store-canvas";
        root.style.cssText = [
          "position:fixed",
          "left:0",
          "top:0",
          `width:${c.width}px`,
          `height:${c.height}px`,
          `background-color:${palette.background}`,
          "overflow:hidden",
          "z-index:2147483647",
          "font-family:var(--font-sans)",
        ].join(";");

        // THE CIPHER FIELD, on the plate, under everything. Forced here rather than
        // in the banner at the maintainer's request, and with a much higher opacity
        // range than the earlier attempts: measured, the range that reads on this
        // plate starts around 0.3, and the previous p50 of 0.19 was inside the band
        // screen brightness eats, which is why it was reported missing three times.
        const field = document.createElement("div");
        field.style.cssText = "position:absolute;left:0;top:0;right:0;bottom:0";
        for (const seg of cipherSegs) {
          const el = document.createElement("div");
          el.textContent = seg.text;
          el.style.cssText = [
            "position:absolute",
            `left:${seg.x}px`,
            `top:${seg.y}px`,
            "font-family:var(--font-mono)",
            `font-size:${seg.size}px`,
            "letter-spacing:0.10em",
            "white-space:nowrap",
            `color:${palette.cipherBright}`,
            `opacity:${seg.alpha}`,
            "pointer-events:none",
          ].join(";");
          field.append(el);
        }
        root.append(field);

        for (const f of frames) {
          const cell = document.createElement("div");
          cell.style.cssText = [
            "position:absolute",
            `left:${f.x}px`,
            "top:0",
            `width:${c.frameWidth}px`,
            `height:${c.height}px`,
          ].join(";");

          const card = document.querySelector(`[data-screen="${f.screenId}"]`);
          const device = card?.lastElementChild as HTMLElement | null;
          if (!device) throw new Error(`no device frame inside ${f.screenId}`);

          const holder = document.createElement("div");
          holder.style.cssText = [
            "position:absolute",
            `left:${f.geom.device.left}px`,
            `top:${f.geom.device.top}px`,
            `width:${f.box.width}px`,
            `height:${f.box.height}px`,
            `transform:scale(${f.geom.device.scale})`,
            "transform-origin:top left",
          ].join(";");
          // A CLONE. The board's own frame stays where it is so the next frame of
          // the same set can be measured, and a static mock needs no re-render.
          holder.append(device.cloneNode(true));

          cell.append(holder);
          root.append(cell);
        }

        // THE BANNER. One strip across the whole canvas, one cell per frame, so it
        // continues while the reader swipes and only its colour and its words
        // change. Appended after the devices on purpose: the type has to sit IN
        // FRONT of the image, which is the whole point of moving it down here.
        // THE TORN EDGE. One SVG across the whole canvas, one path per frame, all
        // built from ONE shared sample sequence, so neighbouring cells meet at the
        // same point and the tear cannot step at a seam. Positioned one amplitude
        // above the nominal band top, which is where the tear's peaks live.
        const { edgePaths } = payload;
        const svgNS = "http://www.w3.org/2000/svg";
        const bandTop = frames[0].banner.top;
        const bandHeight = frames[0].banner.height;
        const bandSvg = document.createElementNS(svgNS, "svg");
        bandSvg.setAttribute("width", String(c.width));
        bandSvg.setAttribute("height", String(bandHeight + edge.amplitude));
        bandSvg.setAttribute("viewBox", `0 0 ${c.width} ${bandHeight + edge.amplitude}`);
        bandSvg.style.cssText = [
          "position:absolute",
          "left:0",
          `top:${bandTop - edge.amplitude}px`,
        ].join(";");
        for (let i = 0; i < frames.length; i += 1) {
          const path = document.createElementNS(svgNS, "path");
          path.setAttribute("d", edgePaths[i]);
          path.setAttribute("fill", bannerColours[i % bannerColours.length].bg);
          bandSvg.append(path);
        }
        root.append(bandSvg);

        for (let i = 0; i < frames.length; i += 1) {
          const f = frames[i];
          const band = f.banner;
          const pair = bannerColours[i % bannerColours.length];

          const cell = document.createElement("div");
          cell.style.cssText = [
            "position:absolute",
            `left:${f.x}px`,
            `top:${band.top}px`,
            `width:${c.frameWidth}px`,
            `height:${band.height}px`,
            "background:transparent",
            `padding:${Math.round(band.height * 0.22)}px ${band.padX}px`,
            "box-sizing:border-box",
            "display:flex",
            "flex-direction:column",
            "justify-content:center",
            "overflow:hidden",
            "position:absolute",
          ].join(";");

          const eyebrow = document.createElement("div");
          eyebrow.textContent = f.caption.eyebrow;
          eyebrow.style.cssText = [
            `font-size:${band.eyebrowSize}px`,
            "font-family:var(--font-mono)",
            "letter-spacing:0.18em",
            "text-transform:uppercase",
            "font-weight:500",
            `margin-bottom:${band.gap}px`,
            `color:${pair.fg}`,
            "opacity:0.72",
          ].join(";");

          const headline = document.createElement("div");
          headline.textContent = f.caption.headline;
          headline.style.cssText = [
            `font-size:${band.headlineSize}px`,
            "font-weight:700",
            "line-height:1.08",
            "letter-spacing:-0.03em",
            `color:${pair.fg}`,
          ].join(";");

          cell.append(eyebrow, headline);
          root.append(cell);
        }

        // THE FLOATING CARDS, appended last so they sit above the device they
        // overlap. Each card's rectangle is clamped into its OWN frame, because a
        // store carousel shows one image at a time and a card cut by the frame edge
        // stops that frame standing on its own. Continuity is carried by the banner,
        // the cipher field and the torn edge, each drawn once across the canvas.
        for (const f of frames) {
          for (const card of f.cards) {
            const pos = card.pos;
            const el = document.createElement("div");
            el.style.cssText = [
              "position:absolute",
              `left:${pos.left}px`,
              `top:${pos.top}px`,
              `width:${pos.width}px`,
              `transform:rotate(${pos.rotate}deg)`,
              "padding:11px 13px",
              "border-radius:11px",
              "background:rgba(251,251,250,0.97)",
              "border:1px solid rgba(20,20,18,0.10)",
              "box-shadow:0 10px 24px rgba(0,0,0,0.34)",
              "font-family:var(--font-sans)",
              "display:flex",
              "gap:10px",
              "align-items:flex-start",
            ].join(";");

            // The glyph tile: what makes a card read as an OBJECT rather than as a
            // floating sentence. Colour from the palette, never a new one.
            const tile = document.createElement("div");
            tile.style.cssText = [
              "flex:none",
              "width:30px",
              "height:30px",
              "border-radius:8px",
              `background:${cardAccents[card.accent % cardAccents.length]}`,
              "display:flex",
              "align-items:center",
              "justify-content:center",
            ].join(";");
            tile.innerHTML = `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#f7f6ee" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${cardGlyphs[card.icon] ?? ""}"/></svg>`;

            const body = document.createElement("div");
            body.style.cssText = "min-width:0";

            const val = document.createElement("div");
            val.textContent = card.text;
            val.style.cssText = [
              card.mono ? "font-family:var(--font-mono)" : "font-family:var(--font-sans)",
              `font-size:${card.mono ? 13 : 15}px`,
              "font-weight:600",
              "color:#1a1a17",
              "letter-spacing:" + (card.mono ? "0.02em" : "-0.01em"),
              // Prose WRAPS and an identifier ELIDES. A card is part of a published
              // image, and `white-space:nowrap` + ellipsis cut "Sync through your own
              // server" to "your o...", which is not a short version of the claim but
              // a different, meaningless one. An account number is the opposite case:
              // it is deliberately elided, the way the privacy card already spells
              // `MY-4H7Q-...-P4N6`, because a listing has no reason to print one whole.
              card.mono ? "white-space:nowrap" : "white-space:normal",
              card.mono ? "overflow:hidden" : "overflow:visible",
              card.mono ? "text-overflow:ellipsis" : "overflow-wrap:anywhere",
            ].join(";");
            body.append(val);
            if (card.label) {
              const lab = document.createElement("div");
              lab.textContent = card.label;
              lab.style.cssText = ["font-size:11.5px", "line-height:1.35", "color:#6b6a64", "margin-top:3px"].join(";");
              body.append(lab);
            }
            el.append(tile, body);
            root.append(el);
          }
        }

        document.body.append(root);
        window.scrollTo(0, 0);
      },
      {
        canvas,
        cipherSegs,
        edge,
        // Precomputed in Node. `page.evaluate` runs in the browser and cannot call
        // this module's functions, which cost three red sets to remember twice.
        edgePaths: entry.frames.map((_, i) =>
          bannerCellPath(
            edge,
            i,
            entry.frames.length,
            plateGeometry(entry.slot, boxes[i]).banner.height + edge.amplitude,
          ),
        ),
        bannerColours: BANNER_COLOURS,
        cardGlyphs: CARD_GLYPHS,
        cardAccents: CARD_ACCENTS,
        canvasSlot: entry.slot,
        palette: PLATE_PALETTE,
        frames: entry.frames.map((f: { id: string; screenId: string; caption: unknown }, i: number) => ({
          id: f.id,
          screenId: f.screenId,
          caption: f.caption,
          // Positions are computed HERE, in Node, because a `page.evaluate` body
          // runs in the browser and cannot see this module's imports. The page
          // draws; the geometry is decided where a test can read it.
          glow: glowFor(entry.slot, plateGeometry(entry.slot, boxes[i])),
          banner: plateGeometry(entry.slot, boxes[i]).banner,
          cards: f.caption.cards.map(
            (card: { text: string; label?: string; mono?: boolean }, ci: number) => ({
              ...card,
              pos: cardLayout(entry.slot, i, ci, entry.frames.length),
            }),
          ),
          indexInSet: i,
          x: i * entry.slot.viewport.width,
          box: boxes[i],
          geom: plateGeometry(entry.slot, boxes[i]),
        })),
      },
    );

    for (let i = 0; i < entry.frames.length; i += 1) {
      const frame = entry.frames[i];
      await page.evaluate(
        (offset) =>
          new Promise<void>((done) => {
            const root = document.getElementById("store-canvas");
            if (root) root.style.transform = `translateX(${-offset}px)`;
            // Settle on two animation frames before the capture. Measured: without
            // this, one frame of the Android set rendered byte-DIFFERENTLY on every
            // run while its seven siblings were identical, which made the freshness
            // check report phantom drift and would have made a byte-level gate
            // useless. A transform is applied in style, so a screenshot taken before
            // the next paint can catch the old position.
            requestAnimationFrame(() => requestAnimationFrame(() => done()));
          }),
        i * entry.slot.viewport.width,
      );

      // A frame count also costs a paint, and the iPad set at 2x has the widest
      // canvas of the four, so the rAF pair alone was not always enough there: the
      // freshness check caught the residual race as drift on three iPad frames.
      await page.waitForTimeout(120);

      await page.screenshot({
        path: `${frame.out}/${frame.filename}`,
        clip: { x: 0, y: 0, width: entry.slot.viewport.width, height: entry.slot.viewport.height },
      });
    }

    if (process.env.STORE_PANORAMA === "1") {
      // The whole set as one image. The canvas is fixed at 0,0 and sized in
      // explicit pixels, so widening the VIEWPORT to the canvas makes it fit
      // exactly; the board underneath re-renders at that width and does not
      // matter, because the canvas was cloned out of it and sits outside the
      // React tree. Output is then canvas x deviceScaleFactor, which stays under
      // Chromium's per-dimension cap for every set here.
      await page.evaluate(() => {
        const root = document.getElementById("store-canvas");
        if (root) root.style.transform = "none";
      });
      await page.setViewportSize({ width: canvas.width, height: canvas.height });
      await page.waitForTimeout(300);
      // NOT into the set's own root. `printPanorama` writes to a staging
      // directory on purpose: a joined image is a review artefact, and dropping
      // one into `fastlane/.../phoneScreenshots/` puts a file in a PUBLISHABLE
      // root that no set writes, which `check-store-publishable.mjs` rejects.
      // The CLI supplies the directory. Deriving it from the set's own root was
      // the first version's bug: the Apple sets stage under `mobile/store/staged/`
      // while the Android ones write into `fastlane/.../images/`, so one relative
      // walk put the Android panorama inside `fastlane` rather than beside it.
      const { mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const panoramaDir = process.env.STORE_PANORAMA_DIR;
      if (!panoramaDir) throw new Error("STORE_PANORAMA is set but STORE_PANORAMA_DIR is not");
      mkdirSync(panoramaDir, { recursive: true });
      await page.screenshot({ path: join(panoramaDir, `${entry.slot.id}.png`) });
    }

    const box = await page.evaluate(() => {
      const el = document.getElementById("store-canvas");
      const r = el?.getBoundingClientRect();
      return r ? { width: Math.round(r.width), height: Math.round(r.height) } : null;
    });
    expect(box, `canvas for ${entry.slot.id}`).toEqual({ width: canvas.width, height: canvas.height });

    await page.evaluate(() => document.getElementById("store-canvas")?.remove());
    await context.close();
    expect(problems, `page errors while capturing ${entry.slot.id}`).toEqual([]);
  });
}
