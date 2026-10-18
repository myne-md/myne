#!/usr/bin/env node
// check-stories-public-bundle.mjs: the catalogue's PUBLIC variant carries no
// link into a private repository.
//
// ── What this exists for ─────────────────────────────────────────────────────
//
// `design.myne.md` serves a build of `stories/` to anyone who opens it. The
// catalogue mounts the real screens, and its DEFAULT build offers three
// affordances that only work for a member of this project:
//
//   * "Show on GitHub" (`stories.source`), which links a surface's declaration
//     to `github.com/myne-md/myne/blob/<branch>/<file>#L<line>`;
//   * "File issue" (`stories.file-issue`), which opens that repository's
//     `design-system.yml` issue form pre-filled with the story on screen;
//   * the Welcome page's `Source` group, which lists all eight `myne-md`
//     repositories as links.
//
// Every `myne-md` repository is private, so all three are a 404 to a reader of
// the public site. The public variant renders none of them, and this is the
// check that makes "none of them" a property of the ARTEFACT rather than a
// promise about the source.
//
// ── Why a grep over the artefact, and not a test ────────────────────────────
//
// The property is about what is SERVED. A runtime flag would leave all three in
// the bundle, one devtools breakpoint away, and a unit test over the components
// would pass whether the literals survived bundling or not — a module can be
// tree-shaken, reachable or not, and the test would pass either way. What is
// shipped is a property of `stories/dist-public`, so that is what gets read.
// `check-web-third-party.mjs` records the same reasoning at length.
//
// ── Why it also asserts a POSITIVE, which is the load-bearing half ──────────
//
// "No GitHub URL in the artefact" is ALSO satisfied by an empty build, by a
// mis-pointed directory, or by a build that produced nothing this guard can
// read. So the public variant renders a sentinel `data-testid`
// (`stories.catalogue.public`), chosen because a testid is a string literal the
// bundler cannot rename, and this guard fails when the sentinel is absent. That
// is the difference between a guard that looked and a guard that found nothing
// because it read nothing — the shape `AGENTS.md` records as having shipped
// three times over.
//
// A useful side effect: pointing this at the DEFAULT build fails on the sentinel
// (`stories.catalogue.internal`) as well as on the links, so a mis-wired CI step
// names itself instead of reporting a leak it cannot explain.
//
// ── What this does NOT scan, and the real leak that lives there ─────────────
//
// `.txt` is outside the scan, by a reasoned decision in the shared helper
// (`scanned-assets.mjs`'s `IGNORED_EXTENSIONS`): "a URL in prose is a reference a
// human follows, not one the page fetches". That reason is right for the
// origin-counting guards it was written for and WRONG for this property, where
// the thing being hunted IS a link a human follows.
//
// What it hides, measured against the live origin on 2026-10-17: the catalogue
// copies the shared `public/` tree into its output, so `design.myne.md` would
// serve `.well-known/security.txt`, whose `Policy:` and `Canonical:` lines name
// `github.com/myne-md/myne` — a private repository. `https://myne.md/.well-known/
// security.txt` answers 200 with that same file today, so the dead link is a
// pre-existing condition on EVERY Myne origin rather than something this
// catalogue introduces, and correcting it is a `myne-website` change plus a
// decision about where disclosure points.
//
// So the limit is named rather than papered over. Extending the scan to `.txt`
// would make this guard red for a reason this repository cannot fix, and a
// permanently-red guard is one people learn to route around; dropping the fact
// silently would leave a known dead end undocumented. This paragraph is the
// honest middle, and it is the most the guard can claim.
//
// Run after `pnpm stories:build:public`; a missing directory is a failure rather
// than a skip. `MYNE_STORIES_PUBLIC_DIST` overrides the path, so the absent
// branch is exercisable on a machine that has the build.

import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  partitionAssets,
  unknownExtensionMessage,
} from "./lib/scanned-assets.mjs";

export const DEFAULT_DIST = "stories/dist-public";

/** Present only in the public build; its absence means we read the wrong thing. */
export const SENTINEL = "stories.catalogue.public";

/** Present only in the DEFAULT build; naming it makes a mis-wired path obvious. */
export const INTERNAL_MARKER = "stories.catalogue.internal";

/**
 * Everything that must NOT reach the public artefact, each naming what its
 * presence would mean. The message is the finding, not "grep matched".
 */
export const FORBIDDEN = [
  {
    needle: "github.com/myne-md",
    meaning:
      "a link into a private repository. It is a 404 for a reader of " +
      "design.myne.md, so the affordance that builds it is absent from the " +
      "public variant rather than hidden.",
  },
  {
    needle: "stories.source",
    meaning:
      'the "Show on GitHub" affordance\'s testid, so the source link reached ' +
      "the artefact (App.tsx's SourceReference)",
  },
  {
    needle: "stories.file-issue",
    meaning:
      'the "File issue" affordance\'s testid, so the issue-form link reached ' +
      "the artefact (App.tsx's issueUrl)",
  },
];

/**
 * The rule, over an injected file list.
 *
 * Exported and pure so `tests/scripts/storiesPublicBundle.test.ts` can drive
 * every failure direction without a build — the repository's rule is that a
 * guard is verified by breaking it, and a spec that has to run Vite is a spec
 * nobody runs.
 *
 * @param {{ files: readonly { path: string, text: string }[] }} input
 */
export function findProblems({ files }) {
  const problems = [];
  let sentinelSeen = false;
  let internalSeen = false;

  for (const file of files) {
    if (file.text.includes(SENTINEL)) sentinelSeen = true;
    if (file.text.includes(INTERNAL_MARKER)) internalSeen = true;
  }

  if (!sentinelSeen) {
    problems.push({ kind: "no-sentinel", internal: internalSeen });
  }

  for (const file of files) {
    for (const { needle, meaning } of FORBIDDEN) {
      if (file.text.includes(needle)) {
        problems.push({ kind: "forbidden", path: file.path, needle, meaning });
      }
    }
  }

  return problems;
}

/** Human-readable failure output. Kept beside the rule so the two cannot drift. */
export function describe(problems) {
  const lines = [];
  for (const p of problems) {
    if (p.kind === "no-sentinel") {
      lines.push(
        `the public sentinel (\`${SENTINEL}\`) is absent from the scanned files.`,
        p.internal
          ? `  This IS the default build (\`${INTERNAL_MARKER}\` is present), so the build was`
          : `  Nothing identifies this as the public variant — so "no GitHub URL" here`,
        p.internal
          ? `  not run as the public variant. Use \`pnpm stories:build:public\`, not`
          : `  would prove nothing, because an empty or half-written build satisfies it`,
        p.internal
          ? `  \`pnpm stories:build\`, and point this guard at stories/dist-public.`
          : `  too. Check that the build completed and that App.tsx still renders the\n  \`data-testid={__STORIES_PUBLIC__ ? … }\` sentinel on its root element.`,
      );
    } else if (p.kind === "forbidden") {
      lines.push(`  ${p.needle}\n      ${p.meaning}\n      found in: ${p.path}`);
    }
  }
  return lines.join("\n");
}

function main() {
  const DIST = process.env.MYNE_STORIES_PUBLIC_DIST ?? process.argv[2] ?? DEFAULT_DIST;

  if (!existsSync(DIST)) {
    console.error(
      `stories public bundle: ${DIST} does not exist. Run \`pnpm stories:build:public\`\n` +
        `  first — this check reads the artefact, not the source.`,
    );
    process.exit(1);
  }

  // #273 posture, inherited: every served byte, fail-closed on an unclassified
  // extension. An unscanned file in a served tree is where this property stops
  // being checked.
  const { scan, unknown } = partitionAssets(DIST);
  if (unknown.length > 0) {
    console.error(unknownExtensionMessage(unknown));
    process.exit(1);
  }
  if (scan.length === 0) {
    console.error(
      `stories public bundle: no scannable file under ${DIST} — the scan is broken, not the bundle.`,
    );
    process.exit(1);
  }

  const files = scan.map((file) => ({
    path: relative(DIST, file),
    text: readFileSync(file, "utf8"),
  }));
  const problems = findProblems({ files });

  if (problems.length > 0) {
    console.error(`stories public bundle: FAIL\n${describe(problems)}\n`);
    if (problems.some((p) => p.kind === "forbidden")) {
      console.error(
        `  The public variant is built with STORIES_PUBLIC=1 and renders none of these.\n` +
          `  All three name github.com/myne-md, which is private: a reader of\n` +
          `  design.myne.md gets a 404. Fix by making the path ABSENT from the public\n` +
          `  build (\`stories/vite.config.ts\`'s \`isPublic\`), never by hiding the affordance\n` +
          `  at runtime — the URLs would still be in the bytes.`,
      );
    }
    process.exit(1);
  }

  console.log(
    `stories public bundle: ok (${files.length} served file(s) carry the public sentinel ` +
      `and ${FORBIDDEN.length} forbidden marker(s) are absent)`,
  );
}

// Only when run, never when imported — the `check-stories-bundle.mjs` idiom, so
// the spec below can import `findProblems` without the guard exiting the test
// process.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main();
}
