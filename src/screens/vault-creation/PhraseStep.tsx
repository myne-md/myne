// Step 2 of 4 — recovery phrase reveal + Copy/Save + acknowledgement.
//
// Implements design session 2026-04-28-vault-creation-frontend.md:
//   - Q4.1 reveal pattern: blur-by-default + click reveal + window-blur
//     listener that re-blurs on Cmd-Tab / app-switch (walk-away guard).
//   - Q4.2 actions: Copy + Save-as-file via Tauri plugins; clipboard
//     auto-clear after 30 s with a read-precondition (only clear if the
//     content still matches the phrase we wrote, so we never nuke the
//     user's later clipboard).
//   - Q4.3 hierarchy: Copy + Save are ghost variant; "I've saved this →
//     confirm phrase" is the visually primary CTA.
//   - Q8.1 Back from PhraseStep dispatches RESET_TO_PASSWORD; the
//     orchestrator's effect (this file calls a callback) fires
//     `cancel(sessionToken)` and resets the reducer to a fresh password
//     step. No confirmation modal — the user has not saved anything yet.
//   - Q10 step indicator: STEP 2 OF 4 — RECOVERY PHRASE.
//
// Spec: protocol.md § 7 (BIP-39 24-word, English wordlist) + § 7.5.

import { useEffect, useMemo, type Dispatch } from "react";
import {
  writeText as clipboardWriteText,
  readText as clipboardReadText,
  clear as clipboardClear,
} from "@tauri-apps/plugin-clipboard-manager";
import { save as dialogSave } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { logErrorKind } from "../../lib/vault-creation-logging";
import { StepEyebrow, StepHeading, StepLayout } from "./step-shell";
import type { Action } from "./reducer";

interface PhraseStepProps {
  phrase: string[];
  revealed: boolean;
  dispatch: Dispatch<Action>;
  onCancelSession: () => void;
}

const CLIPBOARD_AUTO_CLEAR_MS = 30_000;

export function PhraseStep({
  phrase,
  revealed,
  dispatch,
  onCancelSession,
}: PhraseStepProps) {
  // Re-blur when the user Cmd-Tabs or the OS hides the window.
  useEffect(() => {
    const onBlur = () => dispatch({ type: "PHRASE_HIDDEN" });
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [dispatch]);

  const phraseString = useMemo(() => phrase.join(" "), [phrase]);

  const handleCopy = async () => {
    try {
      await clipboardWriteText(phraseString);
    } catch (e) {
      logErrorKind(e, "clipboard-write-failed");
      return;
    }
    // Auto-clear: only clear if the clipboard still contains exactly
    // what we wrote (the user may have copied something else).
    setTimeout(async () => {
      try {
        const current = await clipboardReadText();
        if (current === phraseString) {
          await clipboardClear();
        }
      } catch (e) {
        logErrorKind(e, "clipboard-auto-clear-failed");
      }
    }, CLIPBOARD_AUTO_CLEAR_MS);
  };

  const handleSave = async () => {
    let path: string | null;
    try {
      path = await dialogSave({
        defaultPath: "myne-recovery-phrase.txt",
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
    } catch (e) {
      logErrorKind(e, "dialog-save-failed");
      return;
    }
    if (!path) return;
    try {
      await writeTextFile(path, phraseString);
    } catch (e) {
      logErrorKind(e, "fs-write-failed");
    }
  };

  return (
    <StepLayout width={600}>
      <StepEyebrow icon="key-round">Step 2 of 4 — recovery phrase</StepEyebrow>
      <StepHeading>Write down these 24 words.</StepHeading>

      <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--fg-2)" }}>
        This phrase, together with your password, is the only way to recover
        your vault. Store it offline — paper, password manager, hardware
        wallet. Treat it like cash.
      </div>

      <div style={{ position: "relative" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 6,
            padding: 16,
            background: "var(--paper-2)",
            border: "1px solid var(--line-1)",
            borderRadius: 6,
            filter: revealed ? "none" : "blur(8px)",
            transition: "filter 180ms cubic-bezier(0.2,0,0,1)",
            userSelect: revealed ? "text" : "none",
          }}
        >
          {phrase.map((word, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 6,
                padding: "6px 10px",
                background: "var(--bg-1)",
                border: "1px solid var(--line-1)",
                borderRadius: 3,
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                fontFeatureSettings: '"ss02","zero","calt"',
              }}
            >
              <span
                style={{
                  color: "var(--fg-3)",
                  minWidth: 18,
                  textAlign: "right",
                }}
              >
                {i + 1}
              </span>
              <span style={{ color: "var(--fg-1)" }}>{word}</span>
            </div>
          ))}
        </div>
        {!revealed && (
          <button
            type="button"
            onClick={() => dispatch({ type: "PHRASE_REVEALED" })}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: 0,
              cursor: "pointer",
              color: "var(--fg-1)",
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 14px",
                background: "var(--bg-1)",
                border: "1px solid var(--line-2)",
                borderRadius: 6,
              }}
            >
              <Icon name="eye" size={14} />
              Reveal phrase
            </span>
          </button>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="ghost" icon="copy" onClick={handleCopy}>
          Copy
        </Button>
        <Button variant="ghost" icon="download" onClick={handleSave}>
          Save as file
        </Button>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <Button variant="ghost" onClick={onCancelSession} icon="arrow-left">
          Back
        </Button>
        <div style={{ flex: 1 }} />
        <Button
          variant="primary"
          onClick={() => dispatch({ type: "PHRASE_ACKED" })}
        >
          I've saved this — confirm phrase
        </Button>
      </div>
    </StepLayout>
  );
}
