// Builds ONE 6600x2868 canvas — five 1320x2868 App Store frames side by side —
// that Chrome renders in a single pass (generate.sh then slices it). Rendering
// one image is what makes the solid backdrop, the mark watermark and the
// seam-riding cards line up exactly across the five frames.
//
// Brand discipline (PRODUCT.md): SOLID surfaces only — no gradient backdrop, no
// glow, no glass/blur. Encryption reads typographically (the monospace
// account-number + wikilink specimens), never as a lock/shield badge. Sentence
// case, no hype words, no emoji.

const fs = require('fs');
const path = require('path');
const S = require('./screens.cjs');
const C = S.C;

const FONT = (f) => `file://${path.join(__dirname, 'fonts', f)}`;
const SLICE = 1320, H = 2868, N = 5, W = SLICE * N;

// Real iPhone 16/17 Pro Max geometry, scaled from points (screen 440x956pt,
// corner radius ~55pt, titanium rail ~5pt, Dynamic Island 125x36pt). Getting
// the radius wrong is exactly what makes a mockup read as "a rounded rectangle".
const SCREEN_W = 968;
const SCALE = SCREEN_W / 440;
const SCREEN_H = Math.round(956 * SCALE);
const RADIUS = Math.round(55 * SCALE);
const RAIL = Math.round(5 * SCALE);
const PHONE_W = SCREEN_W + RAIL * 2;
const PHONE_H = SCREEN_H + RAIL * 2;
const ISLAND_W = Math.round(125 * SCALE);
const ISLAND_H = Math.round(36 * SCALE);
const ISLAND_TOP = Math.round(11 * SCALE);
const PHONE_TOP = 636;

// Solid warm-ink backdrop (one flat colour — no gradient). Light-paper phones
// sit on it at maximum contrast; captions are paper on ink.
const BG = '#100f0d';
const CAP = '#fbfbfa';
const CAP_SUB = 'rgba(251,251,250,.66)';

const FRAMES = [
  { h: 'Notes that<br>stay yours.',     s: 'End-to-end encrypted markdown — plain files after decryption.',        screen: S.home,       dy: 0 },
  { h: 'Write in plain<br>markdown.',   s: 'Wikilinks, backlinks, and live preview. No proprietary format.',       screen: S.editor,     dy: 40 },
  { h: 'See how it<br>connects.',       s: 'Backlinks and a graph, computed on your device.',                      screen: S.graph,      dy: 0 },
  { h: 'No email.<br>No tracking.',     s: 'Your identity is a 20-character account number — nothing else.',       screen: S.account,    dy: 40 },
  { h: 'Make it<br>yours.',             s: 'System, light, dark, or AMOLED — built to read for hours.',            screen: S.appearance, dy: 0 },
];

const phone = (i, f) => {
  const cx = SLICE * i + SLICE / 2;
  const top = PHONE_TOP + f.dy;
  return `
  <div class="phone" style="left:${cx - PHONE_W / 2}px; top:${top}px">
    <div class="btn b-act"></div><div class="btn b-vu"></div><div class="btn b-vd"></div><div class="btn b-pw"></div>
    <div class="rail">
      <div class="screen">
        <div class="scaler">${f.screen()}</div>
        <div class="island"></div>
        <div class="edge"></div>
      </div>
    </div>
  </div>`;
};

// ── seam-riders: solid paper cards (hairline + elevation, NO glass, NO gradient)
// parked on the boundaries so the eye is carried across the gap. Decoration only
// — every headline still reads if a viewer never completes the picture.
const rider = (x, y, rot, html) => `<div class="rider" style="left:${x}px; top:${y}px; transform:rotate(${rot}deg)">${html}</div>`;

const noteCard = `<div class="rcard" style="width:430px">
  <div style="display:flex;align-items:center;gap:12px">
    <span style="width:12px;height:12px;border-radius:50%;background:${C.slate};flex:none"></span>
    <span style="font-size:30px;font-weight:600;color:${C.ink1}">Project Ivy — spec</span></div>
  <div style="font-size:24px;color:${C.ink3};margin-top:12px;line-height:1.4">Draft the sync handshake and the account-number lookup…</div>
  <div style="font-size:22px;color:${C.line3};margin-top:14px">2h ago</div></div>`;

const wikiPill = `<div class="rcard" style="padding:22px 30px;border-radius:999px;display:flex;align-items:center;gap:16px">
  <span style="font-family:'JetBrains Mono';font-size:30px;font-weight:600;color:${C.accent}">[[Reading&nbsp;list]]</span></div>`;

const recoveryCard = `<div class="rcard" style="width:470px">
  <div style="font-size:20px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${C.ink3};margin-bottom:16px">Recovery phrase</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
    ${[['01', 'ribbon'], ['02', 'canyon'], ['03', 'velvet'], ['04', 'harbor']]
      .map(([n, w]) => `<div style="display:flex;align-items:center;gap:12px;background:${C.paper2};border:1px solid ${C.line1};border-radius:10px;padding:12px 16px">
        <span style="font-family:'JetBrains Mono';font-size:20px;color:${C.line3};width:26px">${n}</span>
        <span style="font-family:'JetBrains Mono';font-size:26px;font-weight:500;color:${C.ink1}">${w}</span></div>`).join('')}
  </div></div>`;

const tagPill = `<div style="display:inline-flex;align-items:center;gap:12px;background:${C.accentSoft};border:1px solid ${C.accent};border-radius:999px;padding:16px 28px;box-shadow:0 24px 50px rgba(0,0,0,.45)">
  <span style="font-size:28px;font-weight:600;color:${C.accent}">#research</span></div>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face{font-family:Inter;src:url('${FONT('InterVariable.woff2')}');font-weight:100 900}
  @font-face{font-family:'JetBrains Mono';src:url('${FONT('JetBrainsMono.woff2')}');font-weight:100 800}
  *{margin:0;padding:0;box-sizing:border-box;-webkit-font-smoothing:antialiased}
  body{width:${W}px;height:${H}px;font-family:Inter;overflow:hidden;position:relative;background:${BG}}

  /* Continuous mark watermark — one flat paper colour, spans the seams. */
  .wm{position:absolute;pointer-events:none;opacity:.05}
  .wm svg{display:block}

  .frame{position:absolute;top:0;width:${SLICE}px;height:${H}px}
  .cap{position:absolute;top:150px;left:88px;width:${SLICE - 150}px}
  .cap h1{color:${CAP};font-size:90px;line-height:1.02;font-weight:700;letter-spacing:-3px}
  .cap p{margin-top:30px;color:${CAP_SUB};font-size:39px;line-height:1.32;font-weight:400;letter-spacing:-.4px;max-width:1090px}

  /* ── device ── solid bezel, hairline inner edge, elevation shadow. No gradient. */
  .phone{position:absolute;width:${PHONE_W}px;height:${PHONE_H}px}
  .rail{width:100%;height:100%;border-radius:${RADIUS + RAIL}px;padding:${RAIL}px;background:#2b2a25;
        box-shadow:0 70px 130px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06)}
  .screen{position:relative;width:${SCREEN_W}px;height:${SCREEN_H}px;border-radius:${RADIUS}px;overflow:hidden;background:${C.paper}}
  .scaler{width:440px;height:956px;transform:scale(${SCALE});transform-origin:0 0;display:flex;flex-direction:column;background:${C.paper}}
  .island{position:absolute;top:${ISLAND_TOP}px;left:50%;transform:translateX(-50%);
          width:${ISLAND_W}px;height:${ISLAND_H}px;border-radius:${ISLAND_H / 2}px;background:#000}
  .edge{position:absolute;inset:0;border-radius:${RADIUS}px;pointer-events:none;box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)}
  .btn{position:absolute;background:#3a3934;border-radius:4px}
  .b-act{left:-5px;top:${Math.round(168 * SCALE)}px;width:6px;height:${Math.round(30 * SCALE)}px}
  .b-vu{left:-5px;top:${Math.round(228 * SCALE)}px;width:6px;height:${Math.round(36 * SCALE)}px}
  .b-vd{left:-5px;top:${Math.round(276 * SCALE)}px;width:6px;height:${Math.round(36 * SCALE)}px}
  .b-pw{right:-5px;top:${Math.round(238 * SCALE)}px;width:6px;height:${Math.round(58 * SCALE)}px}

  /* ── seam-riders ── */
  .rider{position:absolute}
  .rcard{background:${C.paper};border:1px solid ${C.line1};border-radius:24px;padding:26px 30px;
         box-shadow:0 30px 70px rgba(0,0,0,.45)}

  ${fs.readFileSync(path.join(__dirname, 'screen.css'), 'utf8')}
</style></head><body>
  <div class="wm" style="left:${SLICE * 2 + 60}px;top:120px"><svg width="1180" height="1180" viewBox="0 0 32 32" fill="none"><path d="M8 22 V10 L16 18 L24 10 V22" stroke="${CAP}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
  <div class="wm" style="left:-260px;top:1640px"><svg width="900" height="900" viewBox="0 0 32 32" fill="none"><path d="M8 22 V10 L16 18 L24 10 V22" stroke="${CAP}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>

  ${FRAMES.map((f, i) => `<div class="frame" style="left:${SLICE * i}px">
      <div class="cap"><h1>${f.h}</h1><p>${f.s}</p></div>
    </div>`).join('')}

  ${FRAMES.map((f, i) => phone(i, f)).join('')}

  ${rider(SLICE * 1 - 250, 1170, -4, noteCard)}
  ${rider(SLICE * 2 - 150, 2280, 4, wikiPill)}
  ${rider(SLICE * 3 - 250, 1150, -4, recoveryCard)}
  ${rider(SLICE * 4 - 120, 2300, 5, tagPill)}
</body></html>`;

fs.writeFileSync(path.join(__dirname, 'panorama.html'), html);
console.log(`  wrote panorama.html — ${W}x${H} · phone ${PHONE_W}x${PHONE_H}, screen radius ${RADIUS}px (=55pt)`);
