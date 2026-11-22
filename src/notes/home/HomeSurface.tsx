// The home surface (myne-md/myne#1074).
//
// ── What this surface is ────────────────────────────────────────────────────
// A column of cards that answer "where was I, and what is due". Every card
// renders a module that already owns its data; the surface itself owns only the
// ARRANGEMENT, which is a synced preference (`prefs.home_cards`) plus a
// device-local "open this on start" switch.
//
// ── Why the arrangement is a list and not a canvas ──────────────────────────
// Cards are ordered and each takes one or two columns. That is deliberately the
// same model the ribbon, the bottom bar and the toolbar already use, which is why
// the edit mode is the shared `CustomizeRow` rather than a drag canvas: a 2D
// surface needs its own keyboard story, its own persistence shape and its own
// accessibility contract, and the grill rejected all three as cost without a
// question behind them.
//
// ── Two entry points, one model ─────────────────────────────────────────────
// The surface edits itself (the pencil) and a settings section edits the same
// list. Both write `prefs.home_cards`, so there is one arrangement and no
// second source of truth to reconcile.

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CustomizeRow, useDragReorder } from "../../components/settings/CustomizeList";
import { Icon } from "../../components/primitives/Icon";
import { Button } from "../../components/primitives/Button";
import { Switch } from "../../components/primitives/Switch";
import { setHomeCards, setHomeOpenOnStart, type HomeCard } from "../../lib/prefs";
import { usePrefs } from "../../hooks/usePrefs";
import {
  HOME_CARD_SPECS,
  homeCardLabelKey,
  homeCardSpec,
  resolveHomeCards,
} from "./homeCards";
import { HOME_CARD_BODIES } from "./cardBodies";

/** The column count the grid is laid out on. A card spans one or two of them. */
const COLUMNS = 2;

export function HomeSurface() {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const [editing, setEditing] = useState(false);

  const cards = useMemo(() => resolveHomeCards(prefs.home_cards), [prefs.home_cards]);

  // **Every edit writes the WHOLE list.** The stored value is one ordered array,
  // so a partial write would be a second shape to keep in step; `setHomeCards`
  // validates the batch and refuses a card the codec would skip on the next load.
  const persist = useCallback((next: readonly HomeCard[]) => {
    void setHomeCards(next);
  }, []);

  const reorder = useDragReorder(
    cards.map((c) => c.id),
    (order) => {
      const byId = new Map(cards.map((c) => [c.id, c]));
      persist(order.map((id) => byId.get(id)).filter((c): c is HomeCard => c !== undefined));
    },
  );

  if (editing) {
    return (
      <div data-testid="home.edit" style={{ height: "100%", overflowY: "auto" }}>
        <Header
          title={t("notes.home.arrangeTitle")}
          action={
            <Button variant="primary" onClick={() => setEditing(false)}>
              {t("common.done")}
            </Button>
          }
        />
        <div role="list" style={{ display: "flex", flexDirection: "column", gap: "var(--space-0)" }}>
          {cards.map((card, index) => {
            const spec = homeCardSpec(card.kind);
            return (
              <CustomizeRow
                key={card.id}
                id={card.id}
                icon={spec?.icon}
                label={t(homeCardLabelKey(card.kind))}
                note={
                  spec === undefined ? t("notes.home.cards.unknownNote") : undefined
                }
                index={index}
                total={cards.length}
                reorder={reorder}
                testId={`home.edit.row.${card.id}`}
                trailing={
                  <span style={{ display: "flex", gap: "var(--space-1)", alignItems: "center" }}>
                    {/* The span control: two states, because the grid is two
                        columns. A card the surface cannot draw keeps no control
                        it could act on. */}
                    {spec !== undefined && (
                      <Button
                        variant="ghost"
                        aria-pressed={card.span === COLUMNS}
                        data-testid={`home.edit.span.${card.id}`}
                        onClick={() =>
                          persist(
                            cards.map((c) =>
                              c.id === card.id
                                ? { ...c, span: c.span === COLUMNS ? 1 : COLUMNS }
                                : c,
                            ),
                          )
                        }
                      >
                        {card.span === COLUMNS
                          ? t("notes.home.spanWide")
                          : t("notes.home.spanNarrow")}
                      </Button>
                    )}
                    <Button
                      variant="danger"
                      aria-label={t("notes.home.removeCard", {
                        name: t(homeCardLabelKey(card.kind)),
                      })}
                      data-testid={`home.edit.remove.${card.id}`}
                      onClick={() => persist(cards.filter((c) => c.id !== card.id))}
                    >
                      ×
                    </Button>
                  </span>
                }
              />
            );
          })}
        </div>

        <Section title={t("notes.home.addCard")}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
            {HOME_CARD_SPECS.filter(
              (spec) => !cards.some((card) => card.kind === spec.kind),
            ).map((spec) => (
              <Button
                key={spec.kind}
                variant="secondary"
                icon={spec.icon}
                data-testid={`home.edit.add.${spec.kind}`}
                onClick={() =>
                  persist([
                    ...cards,
                    { id: spec.id, kind: spec.kind, span: spec.defaultSpan },
                  ])
                }
              >
                {t(spec.labelKey)}
              </Button>
            ))}
          </div>
        </Section>

        <Section title={t("notes.home.onStart")}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              fontSize: "var(--text-sm)",
              color: "var(--fg-2)",
            }}
          >
            <Switch
              checked={prefs.home_open_on_start}
              onChange={(next) => void setHomeOpenOnStart(next)}
              ariaLabel={t("notes.home.onStart")}
              testId="home.edit.open-on-start"
            />
            {t("notes.home.onStartHint")}
          </label>
        </Section>
      </div>
    );
  }

  return (
    <div data-testid="home.surface" style={{ height: "100%", overflowY: "auto" }}>
      <Header
        title={t("notes.home.title")}
        action={
          <Button
            variant="ghost"
            icon="pencil"
            onClick={() => setEditing(true)}
            data-testid="home.arrange"
          >
            {t("notes.home.arrange")}
          </Button>
        }
      />
      {cards.length === 0 ? (
        <EmptyState onArrange={() => setEditing(true)} />
      ) : (
        <div
          data-testid="home.cards"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))`,
            gap: "var(--space-3)",
          }}
        >
          {cards.map((card) => (
            <CardShell key={card.id} card={card} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One card's frame: title, icon, and the body.
 *
 * The body is a placeholder until task 14 fills each kind with the module that
 * owns its data. A card whose kind this build does not know says so instead of
 * pretending to be empty, because "no data" and "I cannot draw this" are
 * different answers and only one of them is a bug.
 */
function CardShell({ card }: { card: HomeCard }) {
  const { t } = useTranslation();
  const spec = homeCardSpec(card.kind);
  return (
    <section
      data-testid={`home.card.${card.id}`}
      style={{
        gridColumn: `span ${Math.min(card.span, COLUMNS)}`,
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        minHeight: "calc(var(--space-9) * 2)",
        padding: "var(--space-3)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-2)",
        background: "var(--bg-1)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-1)",
          fontSize: "var(--text-sm)",
          color: "var(--fg-2)",
        }}
      >
        {spec !== undefined && <Icon name={spec.icon} size={14} />}
        <span>{t(homeCardLabelKey(card.kind))}</span>
      </header>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
        {spec === undefined ? (
          t("notes.home.cards.unknownNote")
        ) : (
          <CardBody kind={card.kind} />
        )}
      </div>
    </section>
  );
}

/**
 * The card's body, or an honest note when this build has no renderer for it.
 *
 * The registry and the body map are two lists that can disagree, and the
 * disagreement is silent: a kind declared but not drawn would render an empty
 * card that looks like a broken query. This names it instead.
 */
function CardBody({ kind }: { kind: string }) {
  const { t } = useTranslation();
  const Body = HOME_CARD_BODIES[kind];
  if (Body === undefined) return <>{t("notes.home.cards.pending")}</>;
  return <Body />;
}

function EmptyState({ onArrange }: { onArrange: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "var(--space-6)",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: "var(--text-lg)", color: "var(--fg-1)" }}>
        {t("notes.home.emptyTitle")}
      </div>
      <div style={{ maxWidth: "40ch", fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
        {t("notes.home.emptyBody")}
      </div>
      <Button variant="primary" onClick={onArrange}>
        {t("notes.home.addCard")}
      </Button>
    </div>
  );
}

function Header({ title, action }: { title: string; action: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--space-3)",
        paddingBottom: "var(--space-3)",
      }}
    >
      <h1
        style={{
          margin: 0,
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-xl)",
          fontWeight: "var(--weight-semibold)" as unknown as number,
          color: "var(--fg-1)",
        }}
      >
        {title}
      </h1>
      {action}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: "var(--space-4)" }}>
      <div
        style={{
          fontSize: "var(--text-xs)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--fg-3)",
          marginBottom: "var(--space-2)",
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}
