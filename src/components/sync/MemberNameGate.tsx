// SPDX-License-Identifier: AGPL-3.0
//
// The required name step (myne-md/myne#851 task 8, stories 5 to 7). It runs right
// after an accept lands, and the accept's own completion callback is withheld until
// this finishes, so an accepted vault cannot reach the editor unnamed.
//
// ## Why it asks the ROSTER rather than the store
//
// "Do I need a name?" is a question the roster view already answers: each row
// carries `is_self` (decided by identity, myne-md/myne#859) and `name_state`, which
// distinguishes a verified name from an absent record AND from one that failed
// verification (task 4). The raw store is keyed by `person_id_hash`, which the gate
// has no way to supply for itself, and it carries no verification verdict: asking it
// would mean treating a tampered record as a name.
//
// ## What it deliberately does NOT do
//
// It writes NOTHING until the user saves. Quitting here (story 7) leaves the vault
// exactly as the accept left it: openable, with no name, and the row falling back to
// the fingerprint. There is no skip control, because story 6 makes the step
// unskippable during onboarding; the exit is quitting the app, which is not a
// lockout and not a half-written name either.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import {
  CARD_BODY_STYLE,
  CARD_TITLE_STYLE,
  CenteredCard,
} from "../primitives/CenteredCard";
import { listRoster } from "../../lib/invite";
import { memberNameErrorKey, setMyMemberName } from "../../lib/memberNames";

/** The gate's refusal line. `--danger` here rather than `--warning`: this is the
 *  one place where a refused name BLOCKS the step, so it is a stop rather than the
 *  Members list's advisory marker (`MemberRosterPanel`'s `WARNING_STYLE`). */
const CARD_ERROR_STYLE = {
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
  margin: 0,
} as const;

export function MemberNameGate({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  // `onDone` is usually an inline arrow, so it is read through a ref and the probe
  // below runs once per mount. The `checked` latch goes AFTER the await, never
  // before it: a StrictMode dev mount cleans the first run up mid-flight, so a
  // latch set on entry makes the second run return early while the first bails on
  // its own `cancelled`, and `setChecking(false)` never runs. The bug is
  // invisible in a release build, which never double-mounts (myne-md/myne#871).
  const done = useRef(onDone);
  done.current = onDone;
  const checked = useRef(false);

  useEffect(() => {
    if (checked.current) return;
    let cancelled = false;
    void (async () => {
      let named = false;
      try {
        const view = await listRoster();
        named = view.members.some((member) => member.is_self && member.name_state === "verified");
      } catch {
        // An unreadable roster is not a reason to skip a required step, and it is
        // not a reason to claim a name either: asking is the safe direction.
        named = false;
      }
      if (cancelled) return;
      checked.current = true;
      if (named) {
        done.current();
        return;
      }
      setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setBusy(true);
    setErrorKey(null);
    try {
      await setMyMemberName(draft.trim());
      done.current();
    } catch (error) {
      setErrorKey(memberNameErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  const ready = !busy && draft.trim() !== "";

  return (
    <CenteredCard>
      <h1 data-testid="name-gate.title" style={CARD_TITLE_STYLE}>
        {t("sync.nameGate.title")}
      </h1>
      <p data-testid="name-gate.body" style={CARD_BODY_STYLE}>
        {t("sync.nameGate.body")}
      </p>
      {checking ? (
        <p data-testid="name-gate.checking" style={CARD_BODY_STYLE}>
          {t("sync.nameGate.checking")}
        </p>
      ) : (
        <>
          <Input
            data-testid="name-gate.input"
            aria-label={t("sync.nameGate.label")}
            value={draft}
            disabled={busy}
            autoFocus
            onChange={(e) => {
              setErrorKey(null);
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready) void save();
            }}
          />
          {errorKey ? (
            <p data-testid="name-gate.error" role="alert" style={CARD_ERROR_STYLE}>
              {t(errorKey)}
            </p>
          ) : null}
          <Button
            type="button"
            variant="primary"
            data-testid="name-gate.save"
            disabled={!ready}
            onClick={() => void save()}
          >
            {t("sync.nameGate.save")}
          </Button>
        </>
      )}
    </CenteredCard>
  );
}
