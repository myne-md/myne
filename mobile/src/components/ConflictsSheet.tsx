// Conflicts sheet container (MYND-461 T8 / SYNC-11) — loads the vault's conflict
// copies (notes carrying `conflict: true`), groups them by `conflict_of:`, and
// wires the three reconcile actions to the shared @myne/dialect orchestrators via
// the mobile host adapter (src/lib/conflictCopy.ts). Presentation = ConflictsView.
// Mobile re-implements NONE of the orchestrator logic (SYNC-11); the conflict
// copies stay out of the live feed (dialect §3.6.1).

import { useCallback, useEffect, useState } from "react";
import { noteList, noteRead } from "../lib/notes";
import { frontmatterBody } from "../lib/note-organize";
import { readConflictFromFmBody, readConflictOfFromFmBody } from "../dialect/surgery";
import { deriveTitleSnippet } from "../lib/note-title";
import { keepAsSeparate, discardConflict, applyConflictVersion } from "../lib/conflictCopy";
import { ConflictsView, UNKNOWN_CONFLICT_ORIGINAL, type ConflictCopyRow } from "./ConflictsView";

async function loadConflictGroups(): Promise<Map<string, ConflictCopyRow[]>> {
  const ids = await noteList();
  const groups = new Map<string, ConflictCopyRow[]>();
  for (const id of ids) {
    let text: string;
    try {
      text = await noteRead(id);
    } catch {
      continue; // a note removed mid-scan — skip
    }
    const fm = frontmatterBody(text);
    if (!readConflictFromFmBody(fm)) continue;
    const original = readConflictOfFromFmBody(fm) ?? UNKNOWN_CONFLICT_ORIGINAL;
    const row: ConflictCopyRow = { noteId: id, title: deriveTitleSnippet(text).title };
    const arr = groups.get(original);
    if (arr) arr.push(row);
    else groups.set(original, [row]);
  }
  return groups;
}

export function ConflictsSheet() {
  const [groups, setGroups] = useState<Map<string, ConflictCopyRow[]>>(new Map());

  const reload = useCallback(() => {
    void loadConflictGroups().then(setGroups);
  }, []);
  useEffect(() => reload(), [reload]);

  const onKeepBoth = useCallback(
    (copyId: string) => void keepAsSeparate(copyId).then(reload),
    [reload],
  );
  const onDiscard = useCallback(
    (copyId: string) => void discardConflict(copyId).then(reload),
    [reload],
  );
  const onTakeTheirs = useCallback(
    (copyId: string, originalUuid: string) => void applyConflictVersion(copyId, originalUuid).then(reload),
    [reload],
  );

  return (
    <ConflictsView groups={groups} onKeepBoth={onKeepBoth} onDiscard={onDiscard} onTakeTheirs={onTakeTheirs} />
  );
}
