#!/usr/bin/env node
// check-story-tree.mjs, the rail's parent edges are real (myne-md/myne#847).
//
// The failure this prevents: `parent` is HAND-WRITTEN, and a hand-written edge
// nothing verifies is exactly the class this repository keeps fixing. Three ways
// it goes wrong, and none of them fails a build on its own:
//
//   1. it names a surface that does not exist, so the node silently stays at the
//      top level and the reader never learns the tree is not what was intended;
//   2. the edges form a CYCLE, which makes the tree infinite;
//   3. it names a real surface that is not actually a parent, which is a claim
//      about composition that the module graph contradicts.
//
// Rule 3 is the one worth the code: an import edge in EITHER direction. The
// direction has to be free, because `SettingsModal` imports its panels while
// `ModalShell` is imported BY its children, so "the child imports the parent"
// would reject half the real pairs.
//
// It is a SEPARATE guard from its three neighbours on purpose. `AGENTS.md` gives
// each script one failure it prevents, and "a fabricated edge" is not "a missing
// story": merging them makes the output ambiguous about which one fired.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { enumerateSurfaces, STORIES_DIR } from "./check-story-coverage.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Every `import ... from "<spec>"` specifier in a module's source. */
export function importSpecifiers(source) {
  const out = [];
  const re = /(?:^|\n)\s*import\s[^;]*?from\s+["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(source)) !== null) out.push(match[1]);
  return out;
}

/**
 * True when `a` and `b` are connected by an import, in either direction.
 *
 * Relative specifiers are resolved against the importing file so a path that
 * happens to contain the other basename in a comment does not count.
 */
export function importConnected(pathA, pathB, read = (p) => readFileSync(p, "utf8")) {
  const resolves = (from, specifier) => {
    if (!specifier.startsWith(".")) return null;
    const base = resolve(dirname(from), specifier);
    return [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")];
  };
  const pointsAt = (from, to) =>
    importSpecifiers(read(from)).some((specifier) => {
      const candidates = resolves(from, specifier);
      return candidates !== null && candidates.includes(resolve(to));
    });
  return pointsAt(pathA, pathB) || pointsAt(pathB, pathA);
}

/**
 * Every `surface`/`parent` pair declared by a story file, plus the surfaces that
 * declare no parent.
 *
 * Scanned rather than imported: the guards are zero-dependency `.mjs` and a story
 * file is TSX, so the descriptor grammar is read the same way the catalogue guard
 * reads it, with a lookahead window bounded by the next `surface:`.
 */
export function declaredEdges(sources) {
  const edges = [];
  const surfaces = new Set();
  for (const [file, text] of sources) {
    // Split on the DESCRIPTOR boundaries rather than scanning forward from
    // `surface:`, because a descriptor's fields are not in a fixed order and a
    // forward window happily attributes a field to its neighbour. That is not
    // hypothetical: the first version of this guard read a `parent` written
    // above its own `surface:` line as belonging to the NEXT descriptor, and
    // reported a fabricated edge against the wrong component (myne-md/myne#847).
    for (const block of text.split(/\n\s{2}\{\n/)) {
      const surface = block.match(/^\s*surface:\s*"([^"]+)",\s*$/m);
      if (!surface) continue;
      surfaces.add(surface[1]);
      const parent = block.match(/^\s*parent:\s*"([^"]+)",\s*$/m);
      if (parent) edges.push({ file, surface: surface[1], parent: parent[1] });
    }
  }
  return { edges, surfaces };
}

/** Story sources, one entry per file. */
export function storySources(dir = join(ROOT, STORIES_DIR)) {
  const out = new Map();
  for (const name of readdirNames(dir)) {
    if (!name.endsWith(".tsx")) continue;
    out.set(join(STORIES_DIR, name), readFileSync(join(dir, name), "utf8"));
  }
  return out;
}

function readdirNames(dir) {
  return readdirSync(dir);
}

/** Every problem with the declared edges, one human sentence each. */
export function findings({
  edges,
  surfaces,
  surfacePaths,
  read = (p) => readFileSync(p, "utf8"),
}) {
  const problems = [];
  const parentOf = new Map();

  for (const { surface, parent } of edges) {
    if (parent === surface) {
      problems.push(`"${surface}" names itself as its own parent`);
      continue;
    }
    if (!surfaces.has(parent)) {
      problems.push(`"${surface}" names parent "${parent}", which no story declares`);
      continue;
    }
    const childPath = surfacePaths.get(surface);
    const parentPath = surfacePaths.get(parent);
    if (childPath === undefined || parentPath === undefined) {
      problems.push(
        `"${surface}" -> "${parent}": one of the two has no module under a surface root, so the composition cannot be checked`,
      );
      continue;
    }
    if (!importConnected(childPath, parentPath, read)) {
      problems.push(
        `"${surface}" -> "${parent}": no import edge in either direction, so this is a composition claim the module graph contradicts`,
      );
      continue;
    }
    parentOf.set(surface, parent);
  }

  // Cycles: walk each chain and report the first repeat.
  for (const surface of parentOf.keys()) {
    const seen = new Set([surface]);
    let walker = parentOf.get(surface);
    while (walker !== undefined) {
      if (seen.has(walker)) {
        problems.push(`parent edges form a cycle through "${surface}"`);
        break;
      }
      seen.add(walker);
      walker = parentOf.get(walker);
    }
  }

  return problems;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop());

if (invokedDirectly) {
  const sources = storySources();
  const { edges, surfaces } = declaredEdges(sources);
  const surfacePaths = enumerateSurfaces(ROOT);
  const problems = findings({ edges, surfaces, surfacePaths });

  // The number of edges verified is DEBT: it may only rise. The floor is the
  // measured count on the day this landed, and it is what stops the docs and the
  // rail from quietly disagreeing about how much of the tree is nested
  // (myne-md/myne#847 adversarial pass).
  const EDGE_FLOOR = 1;
  if (edges.length < EDGE_FLOOR) {
    console.error(
      "check-story-tree: FAIL: no `parent` edge was found in any story file, so this guard would pass by checking nothing.",
    );
    process.exit(1);
  }
  if (problems.length > 0) {
    console.error(`check-story-tree: ${problems.length} parent edge(s) that do not hold`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      "\n  Fix the edge, or remove it: a surface with no parent renders at the top level of its group.",
    );
    process.exit(1);
  }
  console.log(
    `check-story-tree: ok (${edges.length} parent edge(s) verified against the module graph; ${surfaces.size} surface(s) declared)`,
  );
}
