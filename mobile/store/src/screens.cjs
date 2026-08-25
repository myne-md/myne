// The five Myne mobile screens, redrawn from the real design tokens
// (docs/design/colors_and_type.css) and the real component structure
// (mobile/src/app/flows/). Marketing mockups, not captures — but every
// colour, radius, spacing step, type size, icon path and label below is the
// app's own value, so what the store shows is what the app renders.
//
// Content is synthetic and generic: no real note, no real account number, no
// real address. Nothing claims more than the threat model backs.

const C = {
  paper: '#fbfbfa', paper2: '#f4f4f2', paper3: '#ecebe7',
  line1: '#e3e2dd', line2: '#c8c7c1', line3: '#a3a29c',
  ink1: '#1a1a17', ink2: '#3a3934', ink3: '#6b6a64', ink0: '#0b0b09',
  accent: '#2c4a7a', accentSoft: '#e8edf5', accentOn: '#ffffff',
  success: '#2f6048', successSoft: '#e3eee8', warning: '#8a6a1f',
  highlight: '#f3e7c4',
  // Label-dot slots (src/notes/decorations.ts) — the only colour a label adds.
  clay: '#b0543f', ochre: '#94701c', moss: '#4d7a55', slate: '#46688a', plum: '#7e4d76', stone: '#6f6d64',
};

// The Myne mark (Icon.tsx MyneMark): ink rounded square + paper "M" chevron.
const mark = (size = 22, r = 4) => `<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none">
  <rect width="32" height="32" rx="${(r / size) * 32}" fill="${C.ink1}"/>
  <path d="M8 22 V10 L16 18 L24 10 V22" stroke="${C.paper}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Lucide-style stroke icon (24 viewBox, currentColor, round caps). `p` may hold
// several subpaths separated by ' / '.
const ic = (p, size = 22, sw = 1.8) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${p
    .split(' / ').map((d) => `<path d="${d}"/>`).join('')}</svg>`;

const P = {
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16z / M21 21l-4.3-4.3',
  gear: 'M12.2 2h-.4a2 2 0 00-2 2v.2a2 2 0 01-1 1.7l-.4.3a2 2 0 01-2 0l-.2-.1a2 2 0 00-2.7.7l-.2.4a2 2 0 00.7 2.7l.2.1a2 2 0 011 1.7v.5a2 2 0 01-1 1.7l-.2.1a2 2 0 00-.7 2.7l.2.4a2 2 0 002.7.7l.2-.1a2 2 0 012 0l.4.3a2 2 0 011 1.7v.2a2 2 0 002 2h.4a2 2 0 002-2v-.2a2 2 0 011-1.7l.4-.3a2 2 0 012 0l.2.1a2 2 0 002.7-.7l.2-.4a2 2 0 00-.7-2.7l-.2-.1a2 2 0 01-1-1.7v-.5a2 2 0 011-1.7l.2-.1a2 2 0 00.7-2.7l-.2-.4a2 2 0 00-2.7-.7l-.2.1a2 2 0 01-2 0l-.4-.3a2 2 0 01-1-1.7V4a2 2 0 00-2-2z / M12 15a3 3 0 100-6 3 3 0 000 6z',
  chevDown12: 'M2 4l4 4 4-4',
  folderPlus: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z / M12 11v5 / M9.5 13.5h5',
  plus: 'M12 5v14 / M5 12h14',
  draw: 'M12 20h9 / M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z',
  templates: 'M8 4h9a2 2 0 012 2v12H8z / M5 8v10a2 2 0 002 2h8',
  calendar: 'M3 5h18v16H3z / M3 10h18M8 3v4M16 3v4',
  layers: 'M12 2 2 7l10 5 10-5-10-5z / M2 12l10 5 10-5 / M2 17l10 5 10-5',
  filter: 'M3 5h18l-7 8v6l-4-2v-6z',
  sort: 'M8 20V4M8 4 5 7M8 4l3 3 / M16 4v16M16 20l-3-3M16 20l3-3',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  discl: 'M9 6l6 6-6 6',
  star: 'M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18.4 6.2 21.4l1.1-6.5L2.6 9.8l6.5-.9z',
  chevLeft: 'M15 18l-6-6 6-6',
  chevRight: 'M9 6l6 6-6 6',
  panel: 'M4 5h16v14H4z / M14 5v14',
  undo: 'M9 14 4 9l5-5 / M4 9h11a5 5 0 010 10h-1',
  redo: 'M15 14 20 9l-5-5 / M20 9H9a5 5 0 000 10h1',
  bullet: 'M8 6h13M8 12h13M8 18h13 / M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  checklist: 'M3 5h7v7H3z / M6 8l1.4 1.4L10 6.5 / M14 7h7M14 12h7M14 17h7',
  quote: 'M6 8H3v5h5V8l-2 4 / M17 8h-3v5h5V8l-2 4',
  code: 'M9 8l-4 4 4 4 / M15 8l4 4-4 4',
  wiki: 'M6 4v16M18 4v16M4 6h4M4 18h4M16 6h4M16 18h4',
  link: 'M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1 / M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1',
  mic: 'M9 3.5h6v10a3 3 0 01-6 0z / M5 11a7 7 0 0014 0M12 18v3',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z / M12 15a3 3 0 100-6 3 3 0 000 6z',
  pen: 'M12 20h9 / M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z',
  copy: 'M9 9h11v11H9z / M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1',
  download: 'M12 3v12 / M7 10l5 5 5-5 / M4 21h16',
  check: 'M20 6 9 17l-5-5',
  keyhole: 'M12 2a7 7 0 00-7 7c0 3 2 5 4.5 6L9 22h6l-.5-7C17 14 19 12 19 9a7 7 0 00-7-7z / M12 9v.01',
  faceid: 'M4 8V6a2 2 0 012-2h2M16 4h2a2 2 0 012 2v2M20 16v2a2 2 0 01-2 2h-2M8 20H6a2 2 0 01-2-2v-2 / M9 10v1M15 10v1M12 9v3l-1 1M9.5 15a3.5 3.5 0 005 0',
};

// ── shared chrome ──────────────────────────────────────────────────────────
const sb = () => `<div class="sb"><span class="sb-t">9:41</span><span class="sb-r">
  <svg width="19" height="13" viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5" width="3" height="7" rx="1"/><rect x="10" y="2" width="3" height="10" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1" opacity=".35"/></svg>
  <svg width="18" height="13" viewBox="0 0 16 12"><path d="M8 11.5 1 4.8a9.8 9.8 0 0 1 14 0z" opacity=".35"/><path d="M8 11.5 4.2 7.8a5.3 5.3 0 0 1 7.6 0z"/></svg>
  <svg width="26" height="13" viewBox="0 0 25 12"><rect x="0" y="0" width="21" height="12" rx="3.5" fill="none" stroke="currentColor" stroke-opacity=".4"/><rect x="2" y="2" width="15" height="8" rx="2"/><path d="M23 4v4a2.6 2.6 0 0 0 0-4z" opacity=".4"/></svg>
</span></div>`;

const header = (vault = 'Personal') => `<div class="hdr">
  <div class="hdr-org">${mark(22, 4)}<span class="nm">${vault}</span>
    <span style="color:${C.ink3}"><svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4l4 4 4-4"/></svg></span>
  </div>
  <div class="hdr-act"><span class="ib" style="color:${C.ink2}">${ic(P.search, 21, 1.7)}</span><span class="ib" style="color:${C.ink2}">${ic(P.gear, 21, 1.7)}</span></div>
</div>`;

const tabbar = (active) => {
  const t = [
    ['Notes', 'M5 3h14v18H5z / M9 8h6M9 12h6M9 16h3', 'rect'],
    ['Graph', 'M8.3 15.6l3-7 / M8.4 16.2l7-1.6', 'graph'],
    ['Files', 'M3 3h18v18H3z / M21 15l-5-5L5 21', 'files'],
  ];
  const inner = {
    rect: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    graph: '<circle cx="6" cy="17" r="2.6"/><circle cx="18" cy="14" r="2.6"/><circle cx="13" cy="6" r="2.6"/><path d="M8.3 15.6l3-7M8.4 16.2l7-1.6"/>',
    files: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="8.5" r="1.8"/><path d="M21 15l-5-5L5 21"/>',
  };
  return `<div class="tabbar">${t
    .map(([l, , k], i) => `<div class="tab ${i === active ? 'on' : ''}">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner[k]}</svg><span>${l}</span></div>`)
    .join('')}</div>`;
};

const dot = (slot) => `<span class="dot" style="background:${C[slot]}"></span>`;
const nrow = (title, sub, { color, star } = {}) => `<div class="nrow">
  <div class="mid"><div class="tt">${color ? dot(color) : ''}${title}</div><div class="su">${sub}</div></div>
  ${star ? `<span style="color:${C.accent}"><svg width="17" height="17" viewBox="0 0 24 24" fill="${C.accent}" stroke="${C.accent}" stroke-width="1"><path d="${P.star}"/></svg></span>` : ''}</div>`;
const frow = (name, count, { open, color } = {}) => `<div class="frow">
  <span class="chev" style="transform:rotate(${open ? 90 : 0}deg)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="${P.discl}"/></svg></span>
  <span style="color:${C.ink2}">${ic(P.folder, 18, 1.6)}</span>
  <span class="nm">${name}</span>${color ? dot(color) : ''}<span class="cnt">${count}</span></div>`;

/* ─────────────────────────  1 · NOTES LIST  ───────────────────────── */
const home = () => `${sb()}${header('Personal')}
<div class="titlerow"><div class="h1">Notes</div>
  <div class="title-act">
    <button class="sqbtn">${ic(P.folderPlus, 18, 1.7)}</button>
    <button class="newnote"><span style="display:flex">${ic(P.plus, 16, 2.1)}</span>New note</button>
  </div></div>
<div class="tiles">
  <div class="tile"><span style="color:${C.ink2}">${ic(P.draw, 19, 1.7)}</span>New drawing</div>
  <div class="tile"><span style="color:${C.ink2}">${ic(P.templates, 19, 1.7)}</span>Templates</div>
  <div class="tile"><span style="color:${C.ink2}">${ic(P.calendar, 19, 1.7)}</span>Open today</div>
  <div class="tile"><span style="color:${C.ink2}">${ic(P.layers, 19, 1.7)}</span>Views</div>
</div>
<div class="toolrow">
  <div class="field">${ic(P.search, 16, 1.8)}<span>Search notes</span></div>
  <div class="tbtn">${ic(P.filter, 18, 1.8)}</div>
  <div class="tbtn">${ic(P.sort, 18, 1.8)}</div>
</div>
<div class="grow">
  <div class="favs"><div class="eyebrow">Favorites</div>
    <div class="fav-row">
      ${[['Z', 'Zettelkasten index'], ['R', 'Reading list'], ['I', 'Project Ivy'], ['D', 'Daily note']]
        .map(([i, n]) => `<div class="fav"><div class="fav-sq">${i}</div><div class="fav-nm">${n}</div></div>`).join('')}
    </div>
  </div>
  <div class="list">
    ${frow('Journal', 42, { open: false, color: 'moss' })}
    ${frow('Projects', 7, { open: true, color: 'slate' })}
    <div class="indent">
      ${nrow('Project Ivy — spec', '2h ago', { color: 'slate' })}
      ${nrow('Threat model — draft', 'yesterday')}
      ${nrow('Weekly review', '3d ago', { star: true })}
    </div>
    ${frow('Research', 128, { open: false, color: 'ochre' })}
    ${nrow('Zettelkasten index', 'yesterday', { star: true })}
    ${nrow('Reading list', 'Jul 12')}
    ${nrow('Gödel, Escher, Bach — notes', '1w ago', { color: 'plum' })}
  </div>
</div>
${tabbar(0)}`;

/* ─────────────────────────  2 · EDITOR  ───────────────────────── */
const editor = () => `${sb()}
<div class="etop">
  <span class="eback">${ic(P.chevLeft, 22, 2)}</span>
  <span class="ecrumb">Research / Zettelkasten</span>
  <span class="eact">${ic(P.panel, 21, 1.7)}<svg width="21" height="21" viewBox="0 0 24 24" fill="${C.ink2}"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg></span>
</div>
<div class="grow"><div class="edoc">
  <div class="md-h1">Zettelkasten index</div>
  <p class="md-p">A <span class="b">slip-box</span> is a network of atomic notes, each linked to the next. The value is not the note — it is the <span class="hl">connections between them</span>.</p>
  <p class="md-p">Start from <span class="wl">[[Reading list]]</span>, then branch into <span class="wl">[[Project Ivy]]</span>.</p>
  <ul class="md-ul"><li>One idea per note</li><li>Link before you file</li><li>Let structure emerge</li></ul>
  <div class="chk done"><span class="box on"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${C.accentOn}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="${P.check}"/></svg></span>Import old notes as plain markdown</div>
  <div class="chk"><span class="box"></span>Write the review for <span class="wl" style="margin-left:4px">[[Weekly review]]</span></div>
  <div class="code"><span class="tok-c"># search across the vault, offline</span>
<span class="tok-k">rg</span> <span class="tok-s">"slip-box"</span> <span class="tok-f">--type</span> md</div>
</div></div>
<div class="fmtbar">
  ${['undo', 'redo'].map((k) => `<span class="fmt">${ic(P[k], 20, 1.7)}</span>`).join('')}
  <span class="fbar-div"></span>
  <span class="fmt txt">H1</span><span class="fmt txt" style="font-size:14px">H2</span>
  <span class="fmt txt" style="font-weight:800">B</span><span class="fmt txt i" style="font-weight:600">I</span>
  <span class="fmt">${ic(P.bullet, 20, 1.7)}</span><span class="fmt">${ic(P.checklist, 20, 1.7)}</span>
  <span class="fmt">${ic(P.quote, 20, 1.7)}</span><span class="fmt">${ic(P.code, 20, 1.7)}</span>
  <span class="fmt" style="font-family:'JetBrains Mono';font-size:15px;font-weight:700">[[</span>
  <span class="fmt">${ic(P.link, 20, 1.7)}</span><span class="fmt">${ic(P.mic, 20, 1.7)}</span>
  <span class="fmt push acc">${ic(P.pen, 20, 1.8)}</span>
</div>`;

/* ─────────────────────────  3 · GRAPH  ───────────────────────── */
const graph = () => {
  // Deterministic node/edge layout — a believable slip-box neighbourhood.
  const N = {
    zk: [220, 300, 13, 'Zettelkasten'], rl: [120, 190, 9, 'Reading list'], iv: [330, 200, 10, 'Project Ivy'],
    tm: [345, 360, 8, 'Threat model'], wr: [150, 400, 7, 'Weekly review'], geb: [95, 300, 8, 'GEB'],
    at: [250, 470, 7, 'Atomic notes'], li: [400, 285, 6, 'Linking'], ob: [60, 430, 6, ''],
    ka: [300, 540, 6, ''], jr: [180, 520, 6, ''], sp: [420, 430, 5, ''], mv: [40, 210, 5, ''], nx: [370, 500, 5, ''],
  };
  const E = [['zk', 'rl'], ['zk', 'iv'], ['zk', 'tm'], ['zk', 'wr'], ['zk', 'geb'], ['zk', 'at'], ['iv', 'li'], ['iv', 'tm'], ['rl', 'geb'], ['rl', 'mv'], ['wr', 'jr'], ['at', 'ka'], ['at', 'jr'], ['geb', 'ob'], ['tm', 'sp'], ['ka', 'nx'], ['li', 'sp'], ['iv', 'nx']];
  const edges = E.map(([a, b]) => `<line x1="${N[a][0]}" y1="${N[a][1]}" x2="${N[b][0]}" y2="${N[b][1]}" stroke="${C.line2}" stroke-width="1" stroke-opacity=".85"/>`).join('');
  const nodes = Object.values(N).map(([x, y, r, label]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${C.accent}"/>${label ? `<text x="${x}" y="${y + r + 15}" fill="${C.ink2}" font-size="11" font-family="Inter" text-anchor="middle">${label}</text>` : ''}`).join('');
  return `${sb()}${header('Personal')}
<div class="gtop"><div class="h1">Graph</div><div class="gmeta">34 linked notes · 58 links</div></div>
<div class="grow"><div class="gwrap"><svg viewBox="0 0 460 620" preserveAspectRatio="xMidYMid meet">${edges}${nodes}</svg></div></div>
${tabbar(1)}`;
};

/* ─────────────────────────  4 · ACCOUNT NUMBER  ───────────────────────── */
const account = () => `${sb()}
<div class="center">
  <div class="wm">${mark(24, 6)}<span class="w">myne</span></div>
  <div class="flow-eyebrow">Create a vault · 4 of 5</div>
  <div class="vtitle">Your account number</div>
  <p class="lead">This is who you are to the sync server. There is no email and no phone number. Save it alongside your recovery phrase.</p>
  <div class="acct">${mark(24, 5)}<span class="num">MY&#8209;7K2P&#8209;9C4H&#8209;8E3D&#8209;1B5F&#8209;Q6RN</span></div>
  <div class="acct-btns">
    <button class="sbtn">${ic(P.copy, 16, 1.8)}Copy</button>
    <button class="sbtn">${ic(P.download, 16, 1.8)}Save as file</button>
  </div>
  <div class="ack"><span class="box"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${C.accentOn}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="${P.check}"/></svg></span>I've saved my account number</div>
  <div class="noemail">no email · no phone number · no tracking</div>
  <button class="pbtn">Continue</button>
</div>`;

/* ─────────────────────────  5 · APPEARANCE  ───────────────────────── */
const appearance = () => `${sb()}
<div class="set-top"><span class="l">${ic(P.chevLeft, 20, 2)}</span><span class="t">Appearance</span><span class="r">Done</span></div>
<div class="grow"><div class="set-body">
  <div class="set-lbl first">Theme</div>
  <div class="seg4">${['System', 'Light', 'Dark', 'AMOLED'].map((s, i) => `<div class="s ${i === 1 ? 'on' : ''}">${s}</div>`).join('')}</div>
  <div class="set-lbl">Text size</div>
  <div class="segp">${['S', 'M', 'L', 'XL'].map((s, i) => `<div class="s ${i === 1 ? 'on' : ''}">${s}</div>`).join('')}</div>
  <div class="set-lbl">Editor font</div>
  <div class="segp">${['Sans', 'Mono'].map((s, i) => `<div class="s ${i === 0 ? 'on' : ''}">${s}</div>`).join('')}</div>
  <div class="set-lbl">Line spacing</div>
  <div class="segp">${['Tight', 'Normal', 'Relaxed'].map((s, i) => `<div class="s ${i === 1 ? 'on' : ''}">${s}</div>`).join('')}</div>
  <div class="set-lbl">Language</div>
  <div class="grp"><div class="trow"><div class="tx"><div class="tt">App language</div></div><span class="rowchev">English ${ic(P.chevRight, 16, 1.8)}</span></div></div>
  <div class="set-lbl">Home quick actions</div>
  <div class="grp">
    <div class="trow"><div class="tx"><div class="tt">Show edit times</div></div><div class="sw on"><div class="knob"></div></div></div>
    <div class="trow"><div class="tx"><div class="tt">New drawing</div></div><div class="sw on"><div class="knob"></div></div></div>
  </div>
  <div class="foot">myne · encrypted on this device · open source</div>
</div></div>`;

module.exports = { home, editor, graph, account, appearance, mark, ic, P, C };
