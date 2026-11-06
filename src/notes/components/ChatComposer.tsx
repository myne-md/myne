// The AI tab's one composer.
//
// **Why there is exactly one.** The tab used to mount two: the chat composer
// inside `AiChatTab` and `AgentComposer` beside it, each with its own input and
// its own Send. That was never the recorded design: `docs/decisions/ai/0515`
// puts the agent's entry point in chat, and `AiChatTab`'s own comment claimed
// "the agent surface rides this tab rather than opening a second AI place" while
// the composer sat outside it. Two inputs is not a smaller decision than one; it
// is the same decision, unmade, in front of every user who opens the tab.
//
// **There is no Ask/Edit control any more** (myne-md/myne#552,
// `docs/decisions/ai/0524`). Every message starts an agent run: the agent
// answers a question with its `finish` summary and proposes edits when that is
// what was asked for. The segment that used to choose the flow now chooses the
// permission mode. The asymmetry the old control was justified by has not
// changed and is not being denied — it is that in one mode every message
// deliberately pays the expensive side, because the expensive side can now
// answer questions too (`search_vault`, `0523`).
//
// **Two things here are load-bearing rather than layout.**
//
//   1. The scope control. `0515` records it as the mitigation for the
//      model-originated scope expansion, which is the injection-reachable path:
//      "Removing that control does not make the feature smaller; it routes every
//      folder-scale run through the riskier of the two mechanisms." It shows the
//      host's note count before sending, because "Projects" is not a size.
//   2. The probe stays on the first Send. Not on mount, and not on a control
//      change either: with a remote provider configured the probe issues
//      `threshold.attempts` requests to that provider, and TB13 bars a surface
//      that fires without the user asking. Opening the tab costs nothing; the
//      Send pays for the check. What myne-md/myne#568 changed is only how long
//      one answer LIVES — the verdict is session state in `agentStore` rather
//      than this component's, so a tab switch no longer re-buys it — never when
//      it is bought.

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { IconButton } from "../../components/primitives/IconButton";
import { AnchoredPanel } from "../../components/primitives/AnchoredPanel";
import type { IconName } from "../../lib/icons";
import { Spinner } from "../../components/Spinner";
import {
  agentCancel,
  agentCapability,
  agentPreviewGrant,
  type GrantPreview,
  type ProbeVerdict,
  type ScopeGrant,
} from "../../lib/agent-run";
import { providerErrorKey } from "../../lib/engine-error";
import { defaultGrantFor } from "../../lib/agent-protocol";
import {
  getAgent,
  setAutoApply,
  setProbeVerdict,
  useAgent,
} from "../agent/agentStore";
import { startAgentRun } from "../ai/agentToChat";
import {
  attachmentDelete,
  attachmentImport,
  attachmentReadExtractedText,
  type CatalogEntry,
} from "../../lib/attachments";
import type { RunAttachment } from "../../lib/agent-run-core";
import { AttachmentPickerDialog, MAX_RUN_ATTACHMENTS } from "./AttachmentPickerDialog";
import { AttachmentThumbnail } from "../../components/attachments/AttachmentThumbnail";
import { useConversationEpoch } from "../ai/chatStore";
import { useIndexNonce } from "../indexNonce";
import { CAPTION_STYLE } from "./sharedStyles";

export interface ChatComposerProps {
  /** The open note: the default scope when no folder is attached. */
  openNoteId: string | null;
  /**
   * The open note's display name, when the caller knows it (myne-md/myne#913).
   *
   * The run's own `Working on:` line said "This note", which is a pointer and not
   * a name: in a pane running two notes side by side it did not say WHICH note the
   * run was about, and in a transcript read back later it says nothing at all.
   * Optional rather than required because a caller with no note set (a test, the
   * isolated surface) has no name to give and must still render.
   */
  openNoteTitle?: string | null;
  /**
   * The note this SESSION is anchored to, when the session was opened from one
   * (myne-md/myne#848, on the user's ask).
   *
   * Non-null means the scope is settled: the run reads this note, and the picker
   * is not rendered at all. A conversation opened from a note ("open the agent
   * on this note", the Hub's anchored card) is ABOUT that note by construction,
   * so a control whose only sensible setting is the one already in force is a
   * control that invites a mistake, and the user's read is that widening a
   * session is a SESSION-level decision: a new conversation starts vault-wide.
   *
   * Deliberately NOT `openNoteId`. That one is "the note open beside the box",
   * which is what the LIGHT panel's runs default to and where changing the scope
   * for one message is the point; this one is "the session was opened from this
   * note", which is the agent pane's Focus view. Two facts, two props. */
  anchoredNoteId?: string | null;
  /** Folders the user can attach as a scope. */
  folders: readonly string[];
  /** Called with the ids of notes an automatic apply wrote, so the open pane
   *  re-reads them. Without it the editor keeps showing the pre-apply text and
   *  the pane's next autosave writes that stale buffer back over the edit. */
  onNotesWritten?: (noteIds: readonly string[]) => void;
}

const INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  // Auto-grown by the effect below; these two bound it. Neither is a spacing
  // token the theme owns, so neither is a hardcoded visual value.
  minHeight: 32,
  // **Five lines, and then it scrolls** (myne-md/myne#848). Expressed in `em`
  // rather than px so it follows the type scale: the line box is 1.4em by the
  // declaration below, so 7em IS five lines at whatever `--text-sm` resolves to.
  // A px ceiling was 132, which happened to be about six lines at today's
  // font size and would drift out of agreement with its own comment at another.
  maxHeight: "7em",
  resize: "none",
  // No `overflowY` here on purpose: the growth effect decides it per render,
  // because a box that fits its content has nothing to scroll and a permanently
  // `auto` field drew a thumb beside text that was not cut off
  // (myne-md/myne#1020).
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.4,
  color: "var(--fg-1)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "var(--space-1) var(--space-2)",
};

/** A control under the field: icon, value, and a glyph that says it opens. */
const CONTROL_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
  padding: "var(--space-1) var(--space-2)",
  fontSize: "var(--text-sm)",
  whiteSpace: "nowrap",
};

/** One dropdown on the composer's row: glyph, value, chevron, and a menu.
 *
 *  **Two controls, one shape** (myne-md/myne#848). The scope control was a
 *  dropdown and the permission mode was a button that toggled on press, so the
 *  same row held two different idioms for the same kind of choice, and the
 *  toggle said "Apply automatically" without saying that "Review first" was the
 *  other option, or which of the two it was on. A control whose value is a
 *  word from a set is a dropdown; the glyph says which KIND of choice it is and
 *  the text says which one. */
function ComposerDropdown(props: {
  /** Base testids: `<base>`, `<base>-value`, `<base>-menu`, `<base>-option`. */
  base: string;
  /** The accessible name, the QUESTION this control answers. */
  label: string;
  icon: IconName;
  value: string;
  options: {
    value: string;
    label: string;
    active: boolean;
    /** A small heading rendered above this option when it differs from the
     *  previous one. Used to separate the scope kinds from the folder list. */
    group?: string;
  }[];
  onPick: (value: string) => void;
  /**
   * **What the menu is, above the list** (myne-md/myne#913).
   *
   * The scope menu was a bare list of names: "All notes", "This note", then
   * every folder in the vault, with no statement of what the choice MEANS, what
   * it leaves out, or that it only governs the next message. A user who does not
   * already know the model reads four unrelated nouns and guesses. The heading,
   * the resolved count and the exclusion sentence are the three answers a
   * choice needs before it can be made, and they cost three lines.
   */
  heading?: string;
  /** One line under the list: what the choice applies to. */
  footer?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  return (
    <>
      <span ref={anchorRef} style={{ display: "inline-flex" }}>
        <Button
          variant="ghost"
          data-testid={props.base}
          aria-expanded={open}
          aria-label={props.label}
          onClick={() => setOpen((o) => !o)}
          style={CONTROL_STYLE}
        >
          <Icon name={props.icon} size={14} />
          <span data-testid={`${props.base}-value`}>{props.value}</span>
          <Icon name="chevron-down" size={12} />
        </Button>
      </span>
      {/* `AnchoredPanel` rather than an absolutely positioned box inside the
          row: two controls on one row cannot both anchor a menu at the row's
          left edge, which is what `left: 0` gave the second one. The panel is
          drawn in the body against its OWN trigger, and it owns the dismissal
          (outside press, Escape, reflow) so this component does not need a
          document listener of its own. */}
      <AnchoredPanel
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        // Wider than the old 160: the card carries a sentence, and a menu that
        // wraps the exclusion sentence onto four lines is a menu nobody reads.
        minWidth={props.heading === undefined ? 160 : 240}
        align="start"
        style={SCOPE_MENU_STYLE}
        testId={`${props.base}-menu`}
      >
        {props.heading === undefined ? null : (
          <div
            data-testid={`${props.base}-heading`}
            style={SCOPE_MENU_HEADING_STYLE}
          >
            {props.heading}
          </div>
        )}
        {props.options.map((option, index) => {
          const previousGroup =
            index === 0 ? undefined : props.options[index - 1]?.group;
          return (
            <Fragment key={option.value}>
              {option.group !== undefined && option.group !== previousGroup ? (
                <div
                  data-testid={`${props.base}-group`}
                  style={SCOPE_MENU_GROUP_STYLE}
                >
                  {option.group}
                </div>
              ) : null}
              <Button
                variant="ghost"
                data-testid={`${props.base}-option`}
                data-value={option.value}
                data-active={option.active ? "true" : "false"}
                onClick={() => {
                  props.onPick(option.value);
                  setOpen(false);
                }}
                style={{
                  ...SCOPE_MENU_ITEM_STYLE,
                  // The current one reads as the answer rather than as another
                  // candidate: the menu states the scope AND offers the others,
                  // and a list where all four look alike makes the user re-read
                  // the trigger to know which one they are on.
                  ...(option.active
                    ? { color: "var(--accent)", background: "var(--bg-3)" }
                    : {}),
                }}
              >
                {option.active ? "\u2713 " : ""}
                {option.label}
              </Button>
            </Fragment>
          );
        })}
        {props.footer === undefined ? null : (
          <div data-testid={`${props.base}-footer`} style={SCOPE_MENU_FOOTER_STYLE}>
            {props.footer}
          </div>
        )}
      </AnchoredPanel>
    </>
  );
}

/** The scope menu's chrome. Its placement belongs to `AnchoredPanel`. */
const SCOPE_MENU_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  padding: "var(--space-1)",
  gap: "var(--space-1)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
};

/** The card's question, above the list. */
const SCOPE_MENU_HEADING_STYLE: CSSProperties = {
  padding: "var(--space-1) var(--space-2)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-2)",
  lineHeight: 1.4,
};

/** A kind break inside the list (the folder section). */
const SCOPE_MENU_GROUP_STYLE: CSSProperties = {
  padding: "var(--space-2) var(--space-2) var(--space-1)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  borderTop: "1px solid var(--line-1)",
  marginTop: "var(--space-1)",
};

/** What the choice governs, under the list. */
const SCOPE_MENU_FOOTER_STYLE: CSSProperties = {
  padding: "var(--space-1) var(--space-2) var(--space-2)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  lineHeight: 1.4,
  borderTop: "1px solid var(--line-1)",
  marginTop: "var(--space-1)",
};

/** Only what the primitive does not already do. */
const SCOPE_MENU_ITEM_STYLE: CSSProperties = {
  textAlign: "left",
  justifyContent: "flex-start",
  width: "100%",
  padding: "var(--space-1) var(--space-2)",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  // The scope menu is absolutely positioned against this row.
  position: "relative",
  gap: "var(--space-2)",
};

/**
 * The picker value that means "the whole vault" (myne-md/myne#848).
 *
 * The picker's values are folder paths, and `""` is already the sentinel for
 * "the open note". A NUL byte cannot occur in a canonical folder path, so this
 * cannot collide with a real one, and the alternative shape (a second piece of
 * state beside `attached`) is two values that have to be kept in step, which is
 * exactly the class of bug this control's `conversationEpoch` reset exists to
 * avoid.
 */
export const VAULT_SCOPE_SENTINEL = "\u0000vault";

export function ChatComposer({
  openNoteId,
  openNoteTitle = null,
  anchoredNoteId = null,
  folders,
  onNotesWritten,
}: ChatComposerProps) {
  // `i18n` for its `language`, which the agent run sends to the host: the
  // chosen language lives in this side's localStorage, so the backend has no
  // way to read it, and without it a run answers a Turkish question in English.
  const { t, i18n } = useTranslation();
  // Whether the scope picker is expanded. Collapsed by default: the scope shows
  // as text with a control to change it, so the ordinary run reads as one line.
  // The permission mode lives in the run store rather than here: it is
  // session-scoped and has to be dropped by the same lock teardown that drops
  // the run, which a component's own state cannot be.
  const agent = useAgent();
  /**
   * **A sent attachment leaves the composer** (myne-md/myne#913, on the report
   * that the chip stayed under the input after sending).
   *
   * Keyed on the run OPENING, not on `startAgentRun` resolving: that promise
   * settles when the loop STOPS, so the chips outlived the send by the whole run
   * and read as "still waiting to be sent". `agent.running` flips as soon as the
   * host reports the run, which is the moment the message became the transcript's.
   *
   * A start that fails before opening a run never matches, so the chips stay and
   * the user can press Send again without re-picking.
   */
  useEffect(() => {
    if (!agent.running) return;
    setAttachedDocs([]);
    setAttachmentError(null);
  }, [agent.running]);
  const [message, setMessage] = useState("");
  const [attached, setAttached] = useState<string | null>(null);
  const [preview, setPreview] = useState<GrantPreview | "failed" | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The documents this message will carry (myne-md/myne#913).
   *
   * **Per message, like the scope**, and cleared by the same conversation
   * boundary: a file handed to one question is not a file handed to the next
   * one, and an attachment that silently followed the conversation would be
   * exactly the kind of inherited permission `decisions/ai/0518` refuses.
   */
  const [attachedDocs, setAttachedDocs] = useState<CatalogEntry[]>([]);
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  /** Why the picked documents could not be sent. Rendered under the row, so a
   *  file that has no extractable text is a sentence rather than a message that
   *  goes out without it. */
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [readingDocs, setReadingDocs] = useState(false);
  /**
   * The files being imported right now (myne-md/myne#913).
   *
   * **A placeholder from the first frame, not only when the work finishes.** An
   * image import decrypts, sniffs, encrypts and caches before it returns, which
   * at 4 MB is long enough that a paste with no feedback reads as ignored: the
   * user pastes again, and the second copy is a second file. The label is the
   * file's name, so the placeholder says WHAT is arriving, not merely that
   * something is.
   */
  const [pasting, setPasting] = useState<readonly string[]>([]);
  /** Whether the configured backend can hold the anchored edit format.
   *
   *  Three states in one field rather than a verdict plus a boolean: unasked,
   *  refused-because-unanswerable, and a verdict that speaks for itself. The
   *  two-field version admitted a fourth combination nothing intended, and its
   *  reset path was unreachable, because once the probe has failed the composer
   *  is blocked, so `ensureCapability` can never run again to clear it.
   *
   *  **In the run store rather than here** (myne-md/myne#568). It used to be
   *  this component's own `useState`, so every remount asked again: with a
   *  remote provider that is `threshold.attempts` requests, 8 seconds in the
   *  session that found it, and `AiChatTab` remounts on an ordinary tab switch
   *  in the right panel. The store keeps it for the session and
   *  `clearAgentForLock` drops it, which is the teardown a component cannot
   *  have. WHEN the probe fires has not changed: still the first Send. */
  const probe = agent.probeVerdict;
  /** Offering Send during the window between asking and hearing back would be
   *  the same defect the gate exists to close, so this covers that window.
   *  Component state on purpose, unlike the verdict: it describes a call this
   *  composer has in flight, and a composer that unmounts takes it with it. */
  const [probing, setProbing] = useState(false);
  /** Which attempt the probe is on, while it is on one (myne-md/myne#575).
   *
   *  Component state beside `probing`, and for the same reason: it describes a
   *  call THIS composer has in flight, so a composer that unmounts takes it
   *  with it. The VERDICT is the thing that has to outlive the component, and
   *  it lives in the store. */
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const verdict = typeof probe === "object" ? probe : null;

  /** Run the probe, at most once per session. See the module note for why it is
   *  not fired on mount or on a control change. */
  async function ensureCapability(): Promise<ProbeVerdict | null> {
    // Read through the store rather than trusting this render's snapshot: a
    // sibling composer, or this one after a remount, may have paid for the
    // answer already.
    const known = getAgent().probeVerdict;
    if (typeof known === "object" && known !== null) return known;
    setProbing(true);
    try {
      // **No per-attempt callback** (myne-md/myne#848, on the user's read): the
      // probe reports "attempt 2 of 3" through `onAttempt`, which fed a caption
      // that no longer exists. The fraction is about Myne's retry loop rather
      // than about anything the user can act on, and the button's own
      // "Checking" says the part that matters.
      const v = await agentCapability();
      setProbeVerdict(v);
      return v;
    } catch {
      // Fail CLOSED. An unanswerable probe is not evidence that the backend can
      // hold the format, and offering the run anyway is what this gate exists
      // to prevent.
      setProbeVerdict("failed");
      return null;
    } finally {
      setProbing(false);
    }
  }

  // Memoized, because the preview effect below keys on it: an object literal
  // rebuilt per render would re-issue `agentPreviewGrant` on every streamed
  // token (the same reason `scopeKey` exists).
  // **An anchored session ignores the picker entirely** (myne-md/myne#848): the
  // scope is the note it was opened from, so `attached` cannot move it. The
  // state still exists for the unanchored case, and the conversation epoch still
  // resets it, so a session that stops being anchored does not inherit a scope
  // chosen for another one.
  const anchored = anchoredNoteId !== null && anchoredNoteId !== "";
  const grant: ScopeGrant = useMemo(
    () =>
      anchored
        ? defaultGrantFor(anchoredNoteId)
        : attached === VAULT_SCOPE_SENTINEL
          ? { kind: "vault" }
          : attached !== null
            ? { kind: "folder", value: attached }
            : defaultGrantFor(openNoteId),
    [anchored, anchoredNoteId, attached, openNoteId],
  );

  /**
   * The glyph for the scope, which states the KIND rather than the value: a
   * glyph cannot name a folder, and the tooltip does. The three kinds are the
   * same three the conversation hub draws.
   */
  // The menus' dismissal lives in `AnchoredPanel` now: each control owns its
  // own anchor, so there is one implementation of "outside press, Escape,
  // reflow" rather than one per menu (myne-md/myne#848).


  const scopeIcon: "folder" | "file-text" | "message-square" =
    attached !== null && attached !== VAULT_SCOPE_SENTINEL
      ? "folder"
      : openNoteId !== null && openNoteId !== "" && attached === null
        ? "file-text"
        : "message-square";

  /**
   * The label the run records for its scope, and what the icon's accessible
   * name says.
   *
   * **It mirrors the GRANT, not the picker.** The icon is the only place the
   * value is readable now, so it has to answer the same question
   * `defaultGrantFor` answers: an unattached scope with no note open is the
   * WHOLE VAULT, and a label that said "This note" there would name a note that
   * does not exist, the same lie the picker's old placeholder was fixed for
   * (myne-md/myne#848).
   */
  const scopeLabel =
    attached === VAULT_SCOPE_SENTINEL
      ? t("agent.composer.scopeAllVault")
      : attached !== null
        ? attached
        : openNoteId !== null && openNoteId !== ""
          ? // The name when the caller has it; the pointer only as a fallback.
            (openNoteTitle !== null && openNoteTitle !== ""
              ? openNoteTitle
              : t("agent.composer.scopeOpenNote"))
          : t("agent.composer.scopeAllVault");

  // The count comes from the HOST, resolved by the same code the commit runs.
  // Counting here would leave out the `ai_excluded_folders` clamp, so the number
  // shown before sending would be larger than the scope the user actually gets.
  //
  // **Cleared FIRST, and a failure is its own value.** Leaving the previous
  // answer up while the next one resolves showed one folder's size beside
  // another folder's name, and collapsing a failed call into `null` made "we
  // could not find out" look identical to "nothing is attached".
  //
  // **Every scope shape is previewed, not only a folder** (myne-md/myne#848).
  // The guard used to be `if (attached === null) return`, which was right while
  // the default was "nothing to run against": there was no scope to describe.
  // The default is the whole vault now, and the count is exactly what makes a
  // number the user did not expect explainable, so silence here would hide the
  // exclusions on the one scope that has the most of them.
  // **And again whenever the vault INDEX changes** (myne-md/myne#848, on the
  // user's report). `vault.indices` hydrates at unlock and the notes changed
  // since its snapshot are re-applied afterwards, so a count asked for in that
  // window is answered against a half-filled index, which is how a composer
  // that had just mounted came to say "nothing for the agent to work on yet:
  // every note is excluded from AI, or the vault is empty" on a vault with 431
  // notes, and then to sit on it, because nothing else was going to re-ask.
  // The nonce is the index's own chokepoint signal (myne#277), so this is the
  // answer to "the scope's size changed because the index did".
  const indexNonce = useIndexNonce();
  // **A GRANT change invalidates the answer; an INDEX change does not.**
  // (myne-md/myne#848, on the user's report: the placeholder flickered between
  // "Getting ready…" and "Ask the AI…" while the count caught up.) Clearing on
  // both was over-applied: the reason to clear first is that a stale number
  // would be read against a new scope's name, and an index bump is the SAME
  // scope, the count is being corrected, not replaced. So the previous number
  // stays on screen and is overwritten when the new one arrives, and only a
  // different scope shows the waiting state.
  const askedFor = useRef<ScopeGrant | null>(null);
  useEffect(() => {
    if (askedFor.current !== grant) {
      askedFor.current = grant;
      setPreview(null);
    }
    let live = true;
    void agentPreviewGrant(grant)
      .then((p) => {
        if (live) setPreview(p);
      })
      .catch(() => {
        if (live) setPreview("failed");
      });
    return () => {
      live = false;
    };
  }, [grant, indexNonce]);

  /**
   * The attached scope belongs to ONE conversation (myne-md/myne#771).
   *
   * Nothing remounts this composer when the conversation changes: the rail
   * swaps the transcript above it and the composer stays exactly where it is,
   * so `attached` — a folder the user picked once — was still attached in the
   * next conversation, and the one after that. Every new chat silently started
   * inside the previous chat's grant, which is the opposite of what
   * `docs/decisions/ai/0518` point 1 asks of this control: the scope must be
   * user-originated FOR THIS RUN, and a value inherited from a conversation
   * the user has walked away from is not that.
   *
   * Keyed on the conversation epoch rather than on a conversation ID, because
   * the boundary is not always an id change: "New conversation" moves from a
   * conversation to NO conversation, and the first message of the fresh one
   * then binds an id without any boundary having been crossed. The epoch is
   * bumped exactly at the three transcript boundaries and nowhere else.
   *
   * **It clears the draft too, and that reverses this comment's earlier
   * position** (myne-md/myne#913, on the report that a draft followed the user
   * across every note they switched to). The old rule was "a draft is what the
   * user is holding in their hands"; the cost of that rule is that the box stops
   * being about anything, and a half-typed question about note A silently
   * becomes the question you send about note B. The conversation is the unit the
   * composer serves, so the draft goes with it.
   *
   * What the user LOSES is stated rather than hidden: an unsent draft is not
   * restored when they come back, because the conversation it belonged to is not
   * restored either. A per-conversation draft store is the shape that would keep
   * both, and it is not this change.
   */
  const conversationEpoch = useConversationEpoch();
  useEffect(() => {
    setAttached(null);
    setAttachedDocs([]);
    setAttachmentError(null);
    setPasting([]);
    setMessage("");
  }, [conversationEpoch]);

  /**
   * The scope choices.
   *
   * **The open-note entry is offered only when there IS one** (myne-md/myne#771).
   * It was unconditional and labelled "This note", so in the agent tab — where
   * the tab is usually the focused pane and no note is open — the picker's one
   * entry named something that did not exist, resolved to `null`, and left Send
   * permanently disabled with no other scope in the list to pick instead. A
   * control lying about its own value is worse than one with nothing in it:
   * the user reads "This note" and concludes the app is broken rather than
   * that they have a choice to make.
   */
  const scopeOptions = useMemo<{
    value: string;
    label: string;
    group?: string;
  }[]>(
    () => [
      // The whole vault first: it is what a new conversation opens on, so it is
      // the entry the trigger reads back most of the time (myne-md/myne#848).
      { value: VAULT_SCOPE_SENTINEL, label: t("agent.composer.scopeAllVault") },
      ...(openNoteId !== null && openNoteId !== ""
        ? [{ value: "", label: t("agent.composer.scopeOpenNote") }]
        : []),
      // The folders are a SECTION, not four more nouns in one list
      // (myne-md/myne#913): the kinds above are fixed and about the vault, and
      // these are the vault's own tree, which can be long.
      ...folders.map((f) => ({
        value: f,
        label: f,
        group: t("agent.composer.scopeFolders"),
      })),
    ],
    [folders, openNoteId, t],
  );
  // Before the first probe there is no verdict, so Edit mode is offered and the
  // check happens on Send. After one, it gates.
  const refused = probe === "failed" || verdict?.passed === false;
  const empty = message.trim().length === 0;
  /**
   * **The scope would resolve to nothing** (myne-md/myne#848). The host resolves
   * the grant before sending and refuses an empty set (`AgentError::EmptyGrant`),
   * and the composer learns the same answer one step earlier from its own
   * preview, so the field can refuse the keystroke instead of the send.
   *
   * `preview === null` is NOT this state: that is "the host has not answered
   * yet", and treating it as empty would disable the box on every mount.
   */
  const scopeEmpty = preview !== null && preview !== "failed" && preview.noteCount === 0;
  const blocked =
    empty || busy || probing || refused || scopeEmpty || readingDocs || pasting.length > 0;

  // Grow the input with its content, up to the cap in `INPUT_STYLE`. Measured
  // rather than counted from newlines, so a long wrapped line grows too.
  //
  // **An EMPTY input is one row, whatever the placeholder does.** `scrollHeight`
  // measures the rendered text, and a textarea with no value renders its
  // placeholder, so a placeholder that wrapped at panel width reported two lines
  // and the box opened two rows tall before the user had typed anything. The
  // height would then be a property of the COPY: translate the placeholder into
  // a longer language and the empty composer grows, in every locale, with
  // nothing in the code to point at.
  //
  // **Two more holes, both visible in the sidebar and both fixed here**
  // (myne-md/myne#1020, on the owner's read of it). The growth was measured ONCE
  // at mount, so a box measured at one width and then laid out at a narrower one
  // kept the old height and grew a scrollbar for text that had not changed. And
  // the scrollbar was never asked for: a box that fits its content has nothing
  // to scroll, so `overflow` now follows the fit instead of being permanently
  // `auto`. The three together are why the empty composer could show two lines
  // of a sentence the user could not type into, with a thumb beside it.

  useEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    /**
     * Fit the box to what the user typed.
     *
     * Run on every value change AND on every resize, because the same value
     * needs a different height at a different width, which is the half the
     * one-shot measurement got wrong.
     */
    const fit = () => {
      el.style.height = "auto";
      if (message === "") {
        // Nothing of the user's to fit. The placeholder is not content, so it
        // gets one row and no scrolling, whatever length it is in this locale.
        el.style.overflowY = "hidden";
        return;
      }
      // **The border is part of the height and not part of `scrollHeight`.**
      // The box is `box-sizing: border-box`, so a height written as the measured
      // content left the content box 2px short of it and the field drew a
      // scrollbar for text that fit. Measured in Chromium on the real composer,
      // three typed lines reported `scrollHeight 63` against `clientHeight 61`.
      // The difference is the frame, so the frame is added here rather than
      // absorbed by a tolerance constant nobody could justify.
      const frame = Math.max(0, el.offsetHeight - el.clientHeight);
      const wanted = el.scrollHeight + frame;
      const next = `${wanted}px`;
      if (el.style.height !== next) el.style.height = next;
      // `maxHeight` is the ceiling and it lives in the stylesheet. Reading the
      // overflow back AFTER the write is what tells the two cases apart: when
      // the cap clamped the box, the content is taller than the room it was
      // given and a scrollbar is honest; when it did not, a scrollbar would be
      // chrome around nothing.
      el.style.overflowY = el.scrollHeight > el.clientHeight ? "auto" : "hidden";
    };
    fit();
    // The width this box gets is decided by its host (the panel, a window
    // resize, the settings rail opening). Observing the PARENT rather than the
    // box keeps the write above from re-triggering the observer that caused it.
    const host = el.parentElement;
    if (host === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    return () => observer.disconnect();
  }, [message]);
  // While a run works there is no second Stop control: this button turns
  // into it, in place, like the mobile composer already does. The id may
  // genuinely be null on the first leg (before `agentStart` reports the
  // view), and then the tap has nothing to address yet.
  const running = agent.running;
  const runId = agent.view?.runId ?? null;

  function stop(): void {
    if (runId !== null) void agentCancel(runId);
  }

  async function submit(): Promise<void> {
    if (running) return;
    if (blocked) return;
    const text = message.trim();
    const verdict = await ensureCapability();
    // The refusal is rendered by the notice below; keep what the user typed so
    // switching backend and sending again does not cost them the message.
    if (verdict === null || !verdict.passed) return;
    // **Read the documents BEFORE the message is cleared** (myne-md/myne#913).
    // The host takes text, not attachment ids, so this is the one moment the
    // vault read happens; a read that fails has to leave the message in the box
    // and say why, rather than sending a run that answers about a file it never
    // received.
    let attachments: RunAttachment[] = [];
    if (attachedDocs.length > 0) {
      setReadingDocs(true);
      setAttachmentError(null);
      try {
        const read = await Promise.all(
          attachedDocs.map(async (doc) => ({
            name: doc.filename,
            extracted: await attachmentReadExtractedText(doc.id),
          })),
        );
        const missing = read.find((entry) => entry.extracted === null);
        if (missing !== undefined) {
          // The sentence names the file: "a document has no text" is not
          // actionable when the user attached three.
          setAttachmentError(
            t("agent.attachments.noText", { name: missing.name }),
          );
          return;
        }
        attachments = read.map((entry, i) => ({
          name: entry.name,
          text: entry.extracted!.text,
          // The transcript's chip needs the id and the MIME hint; `read` was
          // built from `attachedDocs` in order, so the index pairs them
          // (myne-md/myne#913).
          ...(attachedDocs[i] === undefined
            ? {}
            : {
                id: attachedDocs[i]!.id,
                contentType: attachedDocs[i]!.content_type,
              }),
        }));
      } catch {
        setAttachmentError(t("agent.attachments.failed"));
        return;
      } finally {
        setReadingDocs(false);
      }
    }
    setMessage("");
    setBusy(true);
    try {
      await startAgentRun(
        text,
        grant,
        {
          scopeLabel,
          startFailed: t("agent.composer.startFailed"),
          // The two sentences a leg that RAN can owe, which the start path only
          // reaches through `legFailureSentence`'s arms (myne-md/myne#848).
          legFailed: t("agent.progress.legFailed"),
          rootGrant: t("agent.progress.expandFailed"),
          // The host's own cause for a gate refusal (no credential, consent
          // missing, not ready), whose sentence names the control that fixes it.
          byCause: (cause) => t(providerErrorKey(cause)),
          autoApplyFailed: t("agent.composer.autoApplyFailed"),
          providerRejected: t("agent.composer.providerRejected"),
          // Resolved through the shared taxonomy key rather than a second
          // chat-only key, so this turn and the mobile run-failure banner read
          // the same sentence by construction (myne-md/myne#675).
          scopeExcluded: t(providerErrorKey("empty_grant")),
        },
        i18n.language || null,
        onNotesWritten,
        // Anchor the conversation to the note when the run is about one note
        // (myne-md/myne#771). A folder or multi-note run is vault-general and
        // gets no anchor, which is what the Hub renders as "not anchored".
        grant.kind === "notes" && grant.value.length === 1 ? grant.value[0]! : null,
        // The documents this run may read (myne-md/myne#913). Empty for an
        // ordinary message, which is what keeps the request byte-identical for
        // every run that attaches nothing.
        attachments,
      );
      // The chips are cleared by the `agent.running` effect above, which fires
      // when the run OPENS rather than when it ends: `startAgentRun` resolves
      // only after the loop stops, and a chip that hung around for the whole run
      // said "this is still waiting to be sent" about a message already sent.
    } finally {
      setBusy(false);
    }
  }

  /**
   * **A pasted file belongs to THIS conversation** (myne-md/myne#913).
   *
   * It is imported encrypted like any other attachment, with `scope: "chat"` so
   * it does not appear in the library: a screenshot dropped into a question is
   * about that question, and the library is the set of files the user curated.
   * A file already in the library dedups to its existing entry and stays there,
   * because it was theirs before the paste.
   *
   * The paste is intercepted rather than left to the textarea, which would
   * otherwise insert the file NAME (or its `[image]` placeholder) into the
   * message as text the user did not type.
   */
  async function handlePaste(
    event: React.ClipboardEvent<HTMLTextAreaElement>,
  ): Promise<void> {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    setAttachmentError(null);
    const room = MAX_RUN_ATTACHMENTS - attachedDocs.length;
    if (room <= 0) {
      setAttachmentError(t("agent.attachments.cap", { count: MAX_RUN_ATTACHMENTS }));
      return;
    }
    const batch = files.slice(0, room);
    // Claimed BEFORE the first await: the placeholder has to be on screen while
    // the import is still asking the vault for keys, or there is no feedback at
    // all during the part the user notices.
    setPasting(batch.map((file, i) => `${i}:${file.name || t("agent.attachments.pastedFile")}`));
    // Declared OUTSIDE the `try` so the catch can erase what already landed.
    const imported: CatalogEntry[] = [];
    // **Only what this batch CREATED, by id** (review round four, data loss). A
    // dedup hit returns an attachment that already existed, and the documented
    // case is a file the user curated in the library and then pasted into a
    // conversation: erasing it on a later file's failure would delete the user's
    // library file, blob and catalog row, with no confirmation and nothing naming
    // it. `deduplicated` is the host's answer and the only safe source for it.
    const createdIds: string[] = [];
    try {
      for (const file of batch) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const att = await attachmentImport(
          {
            kind: "bytes",
            bytes: Array.from(bytes),
            filename: file.name || null,
          },
          "chat",
        );
        if (!att.deduplicated) createdIds.push(att.id);
        imported.push({
          id: att.id,
          content_type: att.content_type,
          created_at: att.created_at,
          filename: att.filename,
          size: att.size,
        });
      }
      setAttachedDocs((docs) =>
        [...docs, ...imported].slice(0, MAX_RUN_ATTACHMENTS),
      );
    } catch {
      // **A batch that fails part-way leaves the files it already stored with
      // nothing naming them** (myne-md/myne#913, review round two): no chip, no
      // turn, and, because pasted files are chat-scoped, no library row either.
      // They are crypto-erased here rather than left for a cleanup sweep the user
      // has no reason to run. Best effort: a failed delete leaves an
      // unreferenced row, which the unused-attachment sweep now offers.
      for (const id of createdIds) {
        void attachmentDelete(id).catch(() => {});
      }
      setAttachmentError(t("agent.attachments.pasteFailed"));
    } finally {
      setPasting([]);
    }
  }

  return (
    <div
      data-testid="ai.composer"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        paddingTop: "var(--space-2)",
        borderTop: "1px solid var(--line-1)",
      }}
    >
      {/* The capability verdict, stated rather than implied by a dead button.
          This is the one place a user finds out that agent mode is unavailable
          on the model they chose. */}
      {refused ? (
        <div
          data-testid="ai.composer-unsupported"
          style={{
            padding: "var(--space-2)",
            borderRadius: "var(--radius-1)",
            background: "var(--bg-2)",
            color: "var(--fg-2)",
            fontSize: "var(--text-sm)",
          }}
        >
          {/* **Two different failures, two different sentences.** A verdict that
              came back failing measured the model. An unanswerable probe
              measured nothing, and telling that user their model is incapable
              and to choose another one is a diagnosis the inputs cannot
              support: their provider may simply have been unreachable for a
              moment. */}
          {verdict === null
            ? t("agent.composer.unchecked")
            : t("agent.composer.unsupported")}
          {verdict !== null ? (
            <>
              {" "}
              {t("agent.composer.unsupportedDetail", {
                passes: verdict.passes,
                attempts: verdict.threshold.attempts,
                required: verdict.threshold.required,
              })}
              {verdict.threshold.provisional ? (
                <> {t("agent.composer.unsupportedProvisional")}</>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          // While a run works the button below is Stop, so this form never
          // submits: only the button stops a run, never a stray Enter from
          // typing the next message.
          if (running) return;
          void submit();
        }}
        style={{ display: "flex", alignItems: "flex-end", gap: "var(--space-2)" }}
      >
        <textarea
          ref={inputRef}
          data-testid="ai.composer-input"
          rows={1}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onPaste={(e) => {
            void handlePaste(e);
          }}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line. `isComposing` is the
            // load-bearing half: an IME commits its candidate with Enter, so
            // without it a Turkish, Japanese or Korean user sends the first
            // syllable they meant to accept. While a run works Enter does
            // nothing: stopping is the button's job, never a keystroke typed
            // into the next message.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (running) return;
              void submit();
            }
          }}
          // **The placeholder states what to type, and nothing else**
          // (myne-md/myne#1020, on the owner's read of the sidebar). It used to
          // carry a sentence about WHY the field was refusing: "Nothing here to
          // ask about yet: this note's folder is excluded from AI." At panel
          // width that is two lines, in a box the user cannot type into and
          // cannot focus, with a scrollbar beside it. The line under the field
          // already says the same thing in numbers ("0 notes", "1 excluded from
          // AI"), and a sentence inside the field is the worst place in the
          // composer for an explanation: it reads as text the user may overwrite
          // and as a field that is broken rather than closed on purpose.
          //
          // **Unanswered is not the same as empty** (myne-md/myne#848, on the
          // user's report), and that one stays: while the scope's size read is
          // in flight the composer knows nothing about the scope, and "Getting
          // ready…" is one short line that makes no claim about the vault.
          placeholder={
            preview === null
              ? t("agent.composer.preparing")
              : t("agent.composer.placeholder")
          }
          aria-label={t("agent.composer.placeholder")}
          disabled={busy || scopeEmpty}
          style={INPUT_STYLE}
        />
        {running ? (
          <Button
            type="button"
            variant="secondary"
            data-testid="ai.composer-stop"
            disabled={runId === null}
            onClick={stop}
          >
            {t("agent.progress.cancel")}
          </Button>
        ) : (
          <Button
            type="submit"
            variant="primary"
            data-testid="ai.composer-send"
            disabled={blocked}
          >
            {/* **The probe reports ON the button** (myne-md/myne#848, on the
                user's read). It used to print a caption under the row,
                "Checking the model… (2/3)", which is a line of prose for a
                state the user is already looking at the control for, and the
                fraction is about Myne's own retry loop rather than about
                anything the user can act on.

                The label DOES change here, and the earlier note that it must
                not was about a longer sentence: this is one word, swapped in a
                window that opens when the user has just pressed Send and closes
                when the field is cleared, not while they are typing into it. */}
            {probing ? <Spinner size={14} style={{ borderWidth: 2 }} /> : null}
            {probing
              ? t("agent.composer.checking")
              : t("editor.chrome.rightPanel.aiChat.send")}
          </Button>
        )}
      </form>

      {/* **The scope line is gone, because there is no longer a scope-less
          state** (myne-md/myne#848). It used to warn that Send was off while
          `defaultGrantFor` returned `null` (no note open, no folder chosen),
          and a vault-wide grant was refused outright. The composer now defaults
          to the whole vault, so the only thing that sentence could say is that
          the app is broken, and it is unreachable: `grant` is never null.
          `agent.composer.needsScope` stays in the catalogs for the blocked
          zero-state the pane design reintroduces (task 11), which is a case
          where a run genuinely cannot be formed. */}


      {/* **One control row, UNDER the input** (myne-md/myne#771). The scope and
          the permission mode were two full-width rows ABOVE it — a caption, a
          value and a Change button on one; a segmented control spanning the
          panel on the other — which in a 280px side panel is a quarter of the
          surface spent on two choices almost nobody changes per message, sat
          between the transcript and the thing you came to type in.

          Below the input rather than above it, because that is the order the
          two are used in: you type, and the settings are what you glance at
          before sending. Above, they were two rows of chrome to read past on
          the way to the composer, every time.

          The scope control itself may NOT be removed, and this does not remove
          it: `docs/decisions/ai/0518` point 1 requires a user-originated scope
          control on the composer, because taking it away routes every
          folder-scale run through the model-originated expansion instead, which
          is the injection-reachable path. What changes is that it costs one row
          instead of two, and one click instead of two.

          **One exception, and it is recorded rather than taken**
          (myne-md/myne#848, `decisions/ai/0663`): an ANCHORED session, one
          opened from a note, renders no picker, because its scope is the note
          by construction and widening belongs to the session, not the message. A
          new conversation starts vault-wide, which is the user-originated path
          that replaces the picker here. The disclosure is unaffected: the count
          and the excluded figure stay, and they are what 0515 names as the
          mitigation. */}
      {/* **What this message carries** (myne-md/myne#913), above the control row
          and below the input: chips rather than a second list, because the
          composer already shows one row of controls and a file is content
          rather than a setting. Each chip is removable on its own; the error
          line sits here too, since this is the row a file is added to. */}
      {attachedDocs.length > 0 || pasting.length > 0 || attachmentError !== null ? (
        <div
          data-testid="ai.composer-attachments"
          style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-1)" }}
        >
          {attachedDocs.map((doc) => (
            <span
              key={doc.id}
              data-testid="ai.composer-attachment"
              data-attachment-id={doc.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-2)",
                padding: "var(--space-1)",
                paddingRight: "var(--space-2)",
                borderRadius: "var(--radius-1)",
                background: "var(--bg-2)",
                border: "1px solid var(--line-1)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-2)",
                maxWidth: "100%",
              }}
            >
              {/* **The file, shown as the file** (myne-md/myne#913). A name in a
                  pill read as another scope value sitting beside "All notes";
                  the thing the user pasted is content, so it gets a preview and
                  its own row above the composer's controls, never inside them. */}
              <span
                style={{
                  flexShrink: 0,
                  width: 32,
                  height: 32,
                  borderRadius: "var(--radius-1)",
                  overflow: "hidden",
                }}
              >
                <AttachmentThumbnail
                  id={doc.id}
                  contentType={doc.content_type}
                  filename={doc.filename}
                  size={32}
                />
              </span>
              <span
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "1px",
                  minWidth: 0,
                  overflow: "hidden",
                }}
              >
                <span
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {doc.filename}
                </span>
                <span style={{ ...CAPTION_STYLE, color: "var(--fg-3)" }}>
                  {Math.max(1, Math.round(doc.size / 1024))} KB
                </span>
              </span>
              <IconButton
                icon="x"
                label={t("agent.attachments.remove", { name: doc.filename })}
                iconSize={12}
                testId="ai.composer-attachment-remove"
                onClick={() =>
                  setAttachedDocs((docs) => docs.filter((row) => row.id !== doc.id))
                }
              />
            </span>
          ))}
          {pasting.map((entry) => (
            <span
              key={entry}
              data-testid="ai.composer-attachment-pending"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-2)",
                padding: "var(--space-1) var(--space-2)",
                borderRadius: "var(--radius-1)",
                background: "var(--bg-2)",
                border: "1px dashed var(--line-2)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-3)",
                maxWidth: "100%",
              }}
            >
              <Spinner size={14} />
              <span
                style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {entry.slice(entry.indexOf(":") + 1)}
              </span>
              <span>{t("agent.attachments.pasting")}</span>
            </span>
          ))}
          {attachmentError !== null ? (
            <span
              data-testid="ai.composer-attachment-error"
              style={{ ...CAPTION_STYLE, color: "var(--danger)" }}
            >
              {attachmentError}
            </span>
          ) : null}
        </div>
      ) : null}

      <div style={ROW_STYLE}>
        {/* The attach control: a `+` that opens the library picker. Its own
            control rather than an entry in the scope menu, because scope is a
            PERMISSION and a document is CONTEXT: the agent reads this file and
            can never write it (myne-md/myne#913). */}
        <IconButton
          icon="plus"
          label={t("agent.attachments.attach")}
          tooltip
          expanded={attachmentPickerOpen}
          testId="ai.composer-attach"
          onClick={() => setAttachmentPickerOpen(true)}
        />
        {/* **The picker is the control, not a disclosure over one.** It used to
            render a caption plus a Change button, and pressing Change REPLACED
            them with this same `SearchableSelect` — whose trigger you then
            pressed to open the menu. Two clicks and a layout shift to reach a
            control that already is a disclosure, in service of an argument
            ("reading a dropdown before typing is friction") that the two-step
            version cost more of than the dropdown ever did. */}
        {anchored ? null : (
        <span
          data-testid="ai.composer-scope-wrap"
          data-blocked={scopeEmpty ? "true" : "false"}
          style={
            scopeEmpty
              ? {
                  borderRadius: "var(--radius-1)",
                  outline: "2px solid var(--accent)",
                  outlineOffset: "1px",
                  display: "inline-flex",
                }
              : { display: "inline-flex" }
          }
        >
        {/* **The controls under the field are icons** (myne-md/myne#848). They
            were a `SearchableSelect` and a `Select`, each spending a panel-width
            box on a choice set once and left, in a 280px sidebar. The glyph
            states the KIND (a note, a folder, or the whole vault) and the
            tooltip and the accessible name carry the full value, because a glyph
            cannot state which folder. The count beside it is what actually has
            to stay legible: it is the disclosure `docs/decisions/ai/0515` names,
            not a nicety. */}
        {/* **The value is WRITTEN beside the icon** (myne-md/myne#848). An
            icon-only control states a kind and hides the value; the reference a
            user brought back is a trigger that reads `icon + value + chevron`,
            and the value is what the run will actually use. The glyph keeps its
            job of saying WHICH KIND, and the text says which one. */}
        <ComposerDropdown
          base="ai.composer-scope"
          label={t("agent.composer.scopeLabel")}
          icon={scopeIcon}
          value={scopeLabel}
          heading={t("agent.composer.scopeQuestion")}
          // The two things the old menu never said (myne-md/myne#913): what the
          // choice covers in time, and what it never covers at all. Both are
          // enforced host-side, so this sentence describes the run rather than
          // promising something the app does not do.
          footer={t("agent.composer.scopeApplies")}
          options={scopeOptions.map((option) => ({
            value: option.value,
            label: option.label,
            ...(option.group === undefined ? {} : { group: option.group }),
            // **Mirrors `grant`, not `attached`** (review finding): with a note
            // open and nothing attached the grant is THAT NOTE, so a menu keyed
            // on `attached` alone marked "All notes" as current while the trigger
            // and the icon said "This note". A control that misstates its own
            // value is the thing this menu's own comment calls worse than one
            // with nothing in it.
            active:
              option.value ===
              (anchored
                ? ""
                : attached !== null
                  ? attached
                  : openNoteId !== null && openNoteId !== ""
                    ? ""
                    : VAULT_SCOPE_SENTINEL),
          }))}
          onPick={(value) => {
            // The sentinel means the vault, `""` means the open note, and
            // anything else is a folder path.
            setAttached(
              value === VAULT_SCOPE_SENTINEL
                ? VAULT_SCOPE_SENTINEL
                : value === ""
                  ? null
                  : value,
            );
          }}
        />
        </span>
        )}

        {/* **The permission mode is a dropdown too** (myne-md/myne#848, and
            a dropdown since myne-md/myne#771). It was a BUTTON that toggled on
            press, which made the row hold two idioms for the same kind of
            choice: the scope control said what it was set to and offered the
            alternatives, and this one said what it was set to and hid the
            alternative behind a press that also CHANGED it. A control whose
            value is a word from a set is a dropdown, the glyph says which kind
            of choice, the text says which one, and the menu is where the other
            one is.
            What the automatic side is bounded by is stated where it is enforced
            (`autoApplyRun`), not here: it stays inside the scope the user
            approved, and a removal still needs its own act because the host
            refuses one inside a bulk approval whatever the caller sends. */}
        <ComposerDropdown
          base="ai.composer-permission"
          label={t("agent.composer.permissionLabel")}
          icon={agent.autoApply ? "play" : "columns-2"}
          value={
            agent.autoApply
              ? t("agent.composer.permissionAuto")
              : t("agent.composer.permissionAsk")
          }
          options={[
            {
              value: "ask",
              label: t("agent.composer.permissionAsk"),
              active: !agent.autoApply,
            },
            {
              value: "auto",
              label: t("agent.composer.permissionAuto"),
              active: agent.autoApply,
            },
          ]}
          onPick={(value) => setAutoApply(value === "auto")}
        />

        {/* **A failed preview says so rather than showing nothing.** An absent
            count reads as "no folder attached", and the count before sending is
            part of the mitigation `docs/decisions/ai/0515` names, not a nicety.
            The expansion dialog already distinguishes "could not find out" from
            "zero" for the same reason. */}
        {preview === "failed" ? (
          <span data-testid="ai.composer-scope-unavailable" style={CAPTION_STYLE}>
            {t("agent.composer.scopeCountUnavailable")}
          </span>
        ) : null}
        {preview !== null && preview !== "failed" ? (
          <>
            <span data-testid="ai.composer-scope-count" style={CAPTION_STYLE}>
              {t("agent.composer.scopeCount", { count: preview.noteCount })}
            </span>
            {/* **Rendered at zero too** (myne-md/myne#848). Hiding it when the
                clamp removed nothing made its absence ambiguous: "no exclusions"
                and "we did not check" read the same, and the second is the one
                that gets a user to approve a scope they did not mean. The
                sentence has a singular/plural pair for one and many, and the
                `_other` form for zero reads "0 notes are excluded and stay out",
                which is exactly the reassurance the line is for. */}
            <span data-testid="ai.composer-scope-excluded" style={CAPTION_STYLE}>
              {t("agent.composer.scopeExcluded", {
                count: preview.excludedCount,
              })}
            </span>
          </>
        ) : null}

      </div>
      <AttachmentPickerDialog
        open={attachmentPickerOpen}
        onClose={() => setAttachmentPickerOpen(false)}
        selectedIds={attachedDocs.map((doc) => doc.id)}
        onPick={(entries) => {
          // **Merge, not replace** (review round five). The picker lists the
          // LIBRARY, so a file already attached from a paste is not among its
          // rows; replacing the list dropped that chip and left the file with
          // nothing naming it, which the sweep would then erase. Order is the
          // run's order: what was already attached, then the new picks.
          setAttachedDocs((docs) => {
            const byId = new Map(docs.map((doc) => [doc.id, doc]));
            for (const entry of entries) byId.set(entry.id, entry);
            return [...byId.values()].slice(0, MAX_RUN_ATTACHMENTS);
          });
          setAttachmentError(null);
        }}
      />
    </div>
  );
}
