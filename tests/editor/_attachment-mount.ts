// @vitest-environment jsdom
//
// Shared CM6 mount harness for the attachment-embed tests (myne#409).
//
// The form-C embed suites all need the same thing: an EditorView with the
// wikilink parser, the attachment catalog stubbed to a fixed row set, and the
// embed decorations installed, then two microtask flushes so the catalog
// loader's promise has resolved before anything is asserted. Three suites
// grew their own copy of it; this is the one.
//
// Follows the `_conformance.ts` / `_synthetic-doc.ts` convention in this
// directory: leading underscore, not a spec file itself.

import { expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { history } from "@codemirror/commands";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import {
  type CatalogRow,
  attachmentCatalogExtension,
  setCatalogLoader,
} from "../../src/editor/attachments/catalog";
import { attachmentEmbedDecorations } from "../../src/editor/decorations/attachment-embed";
import { wikilinkChipExtensions } from "../../src/editor/wikilink";

export interface Mounted {
  view: EditorView;
  host: HTMLElement;
}

/**
 * Mount `doc` with the catalog resolving to `rows`. The loader settles on a
 * microtask, so both flushes are load-bearing: assert before them and the
 * embeds are still rendering their loading state.
 */
export async function mountEmbeds(
  doc: string,
  rows: readonly CatalogRow[],
  opts: { history?: boolean } = {},
): Promise<Mounted> {
  const restore = setCatalogLoader(async () => new Map(rows.map((r) => [r.id, r])));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: 0, head: 0 },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [Wikilink] }),
        ...attachmentCatalogExtension(),
        ...attachmentEmbedDecorations(),
        ...wikilinkChipExtensions(),
        // Opt-in: only the undo test needs a history stack, and installing it
        // everywhere would let a suite pass an undo assertion by accident.
        ...(opts.history === true ? [history()] : []),
      ],
    }),
    parent: host,
  });
  await Promise.resolve();
  await Promise.resolve();
  view.requestMeasure();
  restore();
  return { view, host };
}

/**
 * Tear a mount down. Also sweeps any body-mounted overflow menu a failing
 * assertion left open, so it cannot be found by the next test's query.
 */
export function unmountEmbeds(mounted: Mounted | null): void {
  mounted?.view.destroy();
  mounted?.host.remove();
  for (const stray of document.querySelectorAll('[data-testid$=".menu"]')) stray.remove();
}

/** Open a widget's "⋯" and return the body-mounted menu element. */
export function openEmbedMenu(host: HTMLElement, testidPrefix: string): HTMLElement {
  const button = host.querySelector<HTMLElement>(`[data-testid="${testidPrefix}.menu-button"]`);
  expect(button, `${testidPrefix}.menu-button should render on the embed`).not.toBeNull();
  button?.click();
  const menu = document.querySelector<HTMLElement>(`[data-testid="${testidPrefix}.menu"]`);
  expect(menu, `${testidPrefix}.menu should be body-mounted after the button click`).not.toBeNull();
  return menu as HTMLElement;
}

/** A `data-testid` lookup that fails by name rather than returning null. */
export function requireTestId(root: ParentNode, testid: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
  expect(el, `${testid} should exist`).not.toBeNull();
  return el as HTMLElement;
}
