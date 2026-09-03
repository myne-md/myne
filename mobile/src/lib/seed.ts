// DEV-only test-data seeder. Populates an UNLOCKED, EMPTY vault with a realistic
// spread of everything — folders, notes (tags / wikilinks / markdown features),
// favourites, templates, saved views, attachments (real PNG + PDF bytes imported
// through the actual MYA1 pipeline), and a note's version history — so every
// surface can be exercised without hand-authoring. Everything goes through the
// SAME IPC the app uses, so the data is genuinely encrypted + indexed.
//
// Gated by `import.meta.env.DEV` + an empty-vault check (`maybeSeedTestData`), so
// it never ships and never clobbers real notes. Delete this file to remove it.

import { noteCreate, noteUpdate, noteList, noteRead } from "./notes";
import { frontmatterTitle } from "./note-organize";
import { welcomeNoteTitle } from "./welcomeNote";
import { mutateDeliberateFolders, setFavorites, upsertSavedView, setViewOrder, type SavedView } from "./prefs";
import { normalizeFolderPath } from "../dialect/folderPath";
import { attachmentImport } from "./attachments";
import { emitAttachmentEmbed } from "./attachmentRef";

// ── plaintext builders ───────────────────────────────────────────────────────

/** Every folder `noteText` has been asked to file a seeded note into.
 *
 *  Collected here because this is the ONE place a seeded folder is decided, and
 *  the seeder writes dozens of notes: registering per note would cost one whole
 *  `vault.prefs` re-encrypt each (myne#613). `seedDemoVault` drains it once at
 *  the end. Module scope is safe because the seeder runs once per fresh vault
 *  and drains what it collected; it is cleared at the start of each run anyway.
 */
const seededFolders = new Set<string>();

function noteText(o: { title: string; folder?: string | null; updated: string; body: string }): string {
  const fm = [`title: ${o.title}`];
  if (o.folder) {
    fm.push(`folder: ${o.folder}`);
    const norm = normalizeFolderPath(o.folder);
    if (norm !== null) seededFolders.add(norm);
  }
  fm.push(`updated: ${o.updated}`);
  return `---\n${fm.join("\n")}\n---\n\n${o.body}\n`;
}

function templateText(title: string, body: string): string {
  return `---\ntitle: ${title}\ntemplate: true\n---\n\n${body}\n`;
}

// ── sample attachment bytes ──────────────────────────────────────────────────

/** Draw a small PNG on a canvas and return its bytes (a real, viewable image). */
async function pngBytes(w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): Promise<number[]> {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return [];
  paint(ctx);
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
  if (!blob) return [];
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

// Minimal one-page PDF (pdf.js recovers the xref). ASCII content only.
const SAMPLE_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 220] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 74 >>
stream
BT /F1 22 Tf 34 150 Td (Myne seeded test PDF) Tj 0 -34 Td /F1 13 Tf (Page 1 of 1) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
trailer
<< /Root 1 0 R >>
%%EOF
`;

// ── the seed ─────────────────────────────────────────────────────────────────

export async function seedTestData(): Promise<void> {
  const now = Date.now();
  const H = 3_600_000, D = 24 * H, W = 7 * D;
  const iso = (ago: number) => new Date(now - ago).toISOString();

  // 1) Attachments — real bytes through the MYA1 import pipeline.
  const sunset = await attachmentImport({
    kind: "bytes",
    filename: "sunset.png",
    bytes: await pngBytes(480, 300, (ctx) => {
      const g = ctx.createLinearGradient(0, 0, 0, 300);
      g.addColorStop(0, "#2b1055");
      g.addColorStop(0.55, "#7597de");
      g.addColorStop(1, "#ffb56b");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 480, 300);
      ctx.fillStyle = "#ffd93b";
      ctx.beginPath();
      ctx.arc(240, 210, 46, 0, Math.PI * 2);
      ctx.fill();
    }),
  });
  const diagram = await attachmentImport({
    kind: "bytes",
    filename: "diagram.png",
    bytes: await pngBytes(420, 260, (ctx) => {
      ctx.fillStyle = "#0f1720";
      ctx.fillRect(0, 0, 420, 260);
      ctx.strokeStyle = "#57b6ff";
      ctx.lineWidth = 3;
      for (const [x, y] of [[70, 70], [230, 60], [330, 170], [120, 190]] as const) {
        ctx.beginPath();
        ctx.arc(x, y, 26, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(70, 70);
      ctx.lineTo(230, 60);
      ctx.lineTo(330, 170);
      ctx.lineTo(120, 190);
      ctx.closePath();
      ctx.stroke();
    }),
  });
  const pdf = await attachmentImport({
    kind: "bytes",
    filename: "spec.pdf",
    bytes: Array.from(new TextEncoder().encode(SAMPLE_PDF)),
  });

  // 2) Notes — created in dependency-free order; ids captured for favourites +
  //    version history. Wikilinks reference note TITLES (resolved by the vault).
  const id: Record<string, string> = {};
  // BULK: the seeder writes dozens of notes and each prefs write re-encrypts
  // the whole blob, so registration is not per note here. `noteText` records
  // every folder it files a note into and the one registration is issued at the
  // end of this function.
  seededFolders.clear();
  const add = async (key: string, text: string) => { id[key] = await noteCreate(text, null); };

  await add("welcome", noteText({
    title: "Welcome to Myne", updated: iso(30 * 60_000),
    body: [
      "# Welcome to Myne 👋",
      "",
      "This vault was **seeded** with test data so you can poke at everything.",
      "",
      "- Browse the folder tree (Work, Personal, Journal, Study…)",
      "- Try the saved views, tags, and the command palette",
      "- Open [[Attachments demo]] to see image + PDF embeds",
      "",
      "> [!note] Everything here is encrypted on-device.",
      "",
      "See also: [[Project Roadmap]] · [[Math Notes]] · [[Reading List]]",
      "",
      "#welcome #demo",
    ].join("\n"),
  }));

  await add("roadmap", noteText({
    title: "Project Roadmap", folder: "Work/Projects", updated: iso(2 * D),
    body: [
      "# Project Roadmap",
      "",
      "Status of the current cycle. Related: [[Meeting Notes June]].",
      "",
      "| Phase | Owner | Status |",
      "|-------|-------|--------|",
      "| Design | Ada | ✅ Done |",
      "| Build | Lin | 🚧 WIP |",
      "| Ship | — | ⏳ Planned |",
      "",
      "## Open items",
      "- [x] Lock the spec",
      "- [ ] Wire the API",
      "- [ ] Beta invite list",
      "",
      "#work #planning",
    ].join("\n"),
  }));

  await add("meeting", noteText({
    title: "Meeting Notes June", folder: "Work/Meetings", updated: iso(3 * D),
    body: [
      "# Meeting Notes — June",
      "",
      "**Attendees:** Ada, Lin, Sam",
      "",
      "1. Reviewed [[Project Roadmap]]",
      "2. Agreed on the beta scope",
      "3. Follow-ups assigned",
      "",
      "> Decisions live in the roadmap; action items below.",
      "",
      "- [ ] Sam: draft changelog",
      "- [ ] Lin: fix the sync bug",
      "",
      "#meeting #work",
    ].join("\n"),
  }));

  await add("ideas", noteText({
    title: "Q3 Ideas", folder: "Work", updated: iso(5 * D),
    body: [
      "# Q3 Ideas",
      "",
      "Raw idea dump — nothing committed yet.",
      "",
      "- Offline-first templates",
      "- Smarter backlinks",
      "- A widget for the home screen",
      "",
      "#idea #work",
    ].join("\n"),
  }));

  await add("design", noteText({
    title: "Design System", folder: "Work/Projects", updated: iso(3 * D + 6 * H),
    body: [
      "# Design System",
      "",
      "Core primitives + the token palette.",
      "",
      emitAttachmentEmbed(diagram.id, diagram.filename),
      "",
      "The graph above sketches the component relationships.",
      "",
      "#design #work",
    ].join("\n"),
  }));

  await add("reading", noteText({
    title: "Reading List", folder: "Personal", updated: iso(1 * D),
    body: [
      "# Reading List",
      "",
      "- [ ] *Thinking in Systems* — Meadows",
      "- [ ] *The Timeless Way of Building* — Alexander",
      "- [x] *Deep Work* — Newport",
      "",
      "Notes go in [[Book Notes]].",
      "",
      "#reading #personal",
    ].join("\n"),
  }));

  await add("grocery", noteText({
    title: "Grocery", folder: "Personal", updated: iso(6 * H),
    body: [
      "# Grocery",
      "",
      "- [ ] Coffee",
      "- [ ] Oat milk",
      "- [ ] Tomatoes",
      "- [x] Bread",
      "",
      "#todo #personal",
    ].join("\n"),
  }));

  await add("journal1", noteText({
    title: "Journal 2026-06-20", folder: "Journal", updated: iso(1 * W),
    body: [
      "# 2026-06-20",
      "",
      "Long day. Shipped the editor toolbar and it *finally* feels right.",
      "Tomorrow: attachments.",
      "",
      "#journal",
    ].join("\n"),
  }));

  await add("journal2", noteText({
    title: "Journal 2026-06-25", folder: "Journal", updated: iso(4 * D),
    body: [
      "# 2026-06-25",
      "",
      "Quiet morning, good focus. Read a chapter of [[Book Notes|the book]].",
      "",
      "#journal",
    ].join("\n"),
  }));

  await add("recipe", noteText({
    title: "Pasta al limone", folder: "Personal/Cooking", updated: iso(2 * W),
    body: [
      "# Pasta al limone",
      "",
      "## Ingredients",
      "- 200g spaghetti",
      "- 1 lemon (zest + juice)",
      "- 50g parmesan",
      "",
      "## Steps",
      "1. Boil the pasta",
      "2. Emulsify lemon + parmesan + pasta water",
      "3. Toss and serve",
      "",
      "#recipe #cooking",
    ].join("\n"),
  }));

  await add("math", noteText({
    title: "Math Notes", folder: "Study", updated: iso(8 * D),
    body: [
      "# Math Notes",
      "",
      "The Gaussian integral:",
      "",
      "$$\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}$$",
      "",
      "Euler's identity is $e^{i\\pi} + 1 = 0$.",
      "",
      "#study #math",
    ].join("\n"),
  }));

  await add("code", noteText({
    title: "Code Snippets", folder: "Study", updated: iso(9 * D),
    body: [
      "# Code Snippets",
      "",
      "```js",
      "const sum = (a, b) => a + b;",
      "console.log(sum(2, 3));",
      "```",
      "",
      "```python",
      "def greet(name):",
      "    return f\"hi {name}\"",
      "```",
      "",
      "#code #study",
    ].join("\n"),
  }));

  await add("trip", noteText({
    title: "Trip Plan", folder: "Personal/Travel", updated: iso(10 * D),
    body: [
      "# Trip Plan",
      "",
      "Lisbon, 4 days.",
      "",
      "- Day 1: Alfama walk",
      "- Day 2: Belém + pastéis",
      "- Day 3: day trip to Sintra",
      "",
      "#travel #personal",
    ].join("\n"),
  }));

  await add("book", noteText({
    title: "Book Notes", folder: "Personal", updated: iso(11 * D),
    body: [
      "# Book Notes",
      "",
      "> The systems you build reflect the incentives you set.",
      "",
      "Backlinks from [[Reading List]] and [[Journal 2026-06-25]].",
      "",
      "#reading #notes",
    ].join("\n"),
  }));

  await add("attachments", noteText({
    title: "Attachments demo", updated: iso(1 * D + 2 * H),
    body: [
      "# Attachments demo",
      "",
      "An image embed:",
      "",
      emitAttachmentEmbed(sunset.id, sunset.filename),
      "",
      "And a PDF embed:",
      "",
      emitAttachmentEmbed(pdf.id, pdf.filename),
      "",
      "#demo",
    ].join("\n"),
  }));

  await add("nestedtags", noteText({
    title: "Nested tag demo", updated: iso(12 * D),
    body: [
      "# Nested tags",
      "",
      "Tags can be hierarchical:",
      "",
      "#area/frontend #area/backend #area/frontend/ui",
      "",
      "Useful for the tag browser.",
    ].join("\n"),
  }));

  // 3) Version history — a couple of edits build real snapshots for one note.
  await noteUpdate(id.roadmap, noteText({
    title: "Project Roadmap", folder: "Work/Projects", updated: iso(1 * D),
    body: "# Project Roadmap\n\nBuild phase kicked off. See [[Meeting Notes June]].\n\n- [x] Lock the spec\n- [x] Wire the API\n- [ ] Beta invite list\n\n#work #planning",
  }));
  await noteUpdate(id.roadmap, noteText({
    title: "Project Roadmap", folder: "Work/Projects", updated: iso(3 * H),
    body: "# Project Roadmap\n\nBeta invites going out this week. 🎉\n\n- [x] Lock the spec\n- [x] Wire the API\n- [x] Beta invite list\n\n#work #planning #shipped",
  }));

  // 3b) The ONE folder registration the bulk path owes, drained from what
  // `noteText` recorded. Without it a seeded folder emptied by trashing its
  // notes would vanish, and the unlock back-fill could not recover it either,
  // because it walks LIVE notes (myne#613 review round 2).
  if (seededFolders.size > 0) {
    await mutateDeliberateFolders({ add: [...seededFolders] });
  }

  // 4) Favourites.
  await setFavorites([id.welcome, id.roadmap, id.book]);

  // 5) Templates.
  // Templates are root notes; same bulk reasoning as `add` above.
  await noteCreate(templateText("Meeting notes", "# {{title}}\n\n**Date:** {{date}}\n**Attendees:** \n\n## Agenda\n- \n\n## Notes\n\n## Action items\n- [ ] "), null);
  await noteCreate(templateText("Daily journal", "# {{date}}\n\n## Grateful for\n- \n\n## Today\n\n## Tomorrow\n- [ ] "), null);
  await noteCreate(templateText("Project brief", "# {{title}}\n\n## Problem\n\n## Goal\n\n## Scope\n- \n\n## Risks\n"), null);

  // 6) Saved views — a mix of tag / folder / text / AND filters + view types.
  const views: SavedView[] = [
    { id: crypto.randomUUID(), name: "Work", view_type: "list", filters: { kind: "inFolder", path: "Work" } },
    { id: crypto.randomUUID(), name: "Ideas", view_type: "cards", filters: { kind: "hasTag", tag: "idea" } },
    { id: crypto.randomUUID(), name: "To-do", view_type: "list", filters: { kind: "hasTag", tag: "todo" } },
    { id: crypto.randomUUID(), name: "Reading", view_type: "table", filters: { kind: "hasTag", tag: "reading" } },
    {
      id: crypto.randomUUID(), name: "Work · planning", view_type: "list",
      filters: { kind: "and", children: [{ kind: "inFolder", path: "Work" }, { kind: "hasTag", tag: "planning" }] },
    },
  ];
  for (const v of views) await upsertSavedView(v);
  await setViewOrder(views.map((v) => v.id));
}

/** Seed ONLY in dev, and ONLY when the vault is empty (never clobber real data).
 *  Call it right before the first list load. */
export async function maybeSeedTestData(): Promise<void> {
  if (!import.meta.env.DEV) return;
  try {
    const existing = await noteList();
    if (existing.length > 1) return;
    // A vault created through the real flow carries exactly one note — the
    // onboarding Welcome note (lib/welcomeNote.ts). Treat that as still
    // empty so the dev spread keeps seeding on freshly-created vaults; any
    // OTHER single note is real user data — leave it alone.
    if (existing.length === 1) {
      const only = await noteRead(existing[0]);
      if (frontmatterTitle(only) !== welcomeNoteTitle()) return;
    }
    await seedTestData();
  } catch (e) {
    console.error("[seed] test-data seed failed:", e);
  }
}
