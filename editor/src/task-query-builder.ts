// The task-query block builder (MYND-617, task 10).
//
// **This is what makes the English-only grammar acceptable.** The keyword roster
// is a specification artifact — translating it would mean 24 contracts, 24
// vector sets, and a vault that stops being portable between a user's own
// devices, because a query written under one app language would be unreadable
// under another. The hard edge is softened by never requiring anyone to memorize
// a keyword: the builder writes canonical syntax from choices, and the roster is
// something you read rather than recall.
//
// Assembled from what exists — `openModal` (focus trap, Escape, backdrop click)
// and native form controls — so it adds **no dependency**. Operable by keyboard
// alone from the first version, for the same reason the chip editor is: a
// surface that is the only route to a feature cannot be mouse-only.

import "./task-surfaces.css";
import { openModal } from "./host/lib/imperative-modal";
import i18n from "@myne/editor/i18n";

/** The choices the builder offers. Every one maps to a frozen roster clause. */
export type QueryBuilderChoice = {
  /** `not done` / `done` / any — the completion filter. */
  readonly status: "any" | "todo" | "done";
  /** A due-date window, or none. */
  readonly due: "any" | "overdue" | "today" | "week" | "none";
  /** Restrict to a folder path fragment. Empty means no clause. */
  readonly path: string;
  /** Restrict to a tag. Empty means no clause. */
  readonly tag: string;
  /** One of the five levels, or any. */
  readonly priority: "any" | "highest" | "high" | "medium" | "low" | "lowest";
  readonly sort: "due" | "priority" | "path";
  /** Zero means "no explicit limit" — the default bound applies. */
  readonly limit: number;
};

export const DEFAULT_CHOICE: QueryBuilderChoice = {
  status: "todo",
  due: "any",
  path: "",
  tag: "",
  priority: "any",
  sort: "due",
  limit: 0,
};

/**
 * Render choices as canonical query text.
 *
 * **Canonical syntax, always** — the builder is the reference writer, so its
 * output is what a user reads when they open a block someone else built. Emitting
 * a shorthand here would teach a form the parser accepts but the spec does not
 * freeze.
 */
export function buildQueryText(choice: QueryBuilderChoice): string {
  const lines: string[] = [];
  if (choice.status === "todo") lines.push("not done");
  if (choice.status === "done") lines.push("done");

  switch (choice.due) {
    case "overdue":
      lines.push("due before today");
      break;
    case "today":
      lines.push("due on today");
      break;
    case "week":
      lines.push("due before in 1 week");
      break;
    case "none":
      lines.push("no due date");
      break;
    case "any":
      break;
    default: {
      const exhaustive: never = choice.due;
      return exhaustive;
    }
  }

  const path = choice.path.trim();
  if (path !== "") lines.push(`path includes ${path}`);
  const tag = choice.tag.trim().replace(/^#/, "");
  if (tag !== "") lines.push(`tag includes ${tag}`);
  if (choice.priority !== "any") lines.push(`priority is ${choice.priority}`);

  lines.push(`sort by ${choice.sort}`);
  if (choice.limit > 0) lines.push(`limit ${choice.limit}`);

  return lines.join("\n");
}

/** The whole fenced block the builder inserts. */
export function buildQueryBlock(choice: QueryBuilderChoice): string {
  return ["```tasks", buildQueryText(choice), "```", ""].join("\n");
}

export type QueryBuilderHandle = { close: () => void };

type Options = {
  onInsert: (block: string) => void;
  onCancel?: () => void;
};

function field(label: string, control: HTMLElement, testId: string): HTMLElement {
  const row = document.createElement("label");
  row.className = "cm-task-query-builder-row";
  row.setAttribute("data-testid", testId);
  const span = document.createElement("span");
  span.textContent = label;
  row.appendChild(span);
  row.appendChild(control);
  return row;
}

function select(
  options: ReadonlyArray<{ value: string; label: string }>,
  value: string,
  testId: string,
): HTMLSelectElement {
  const el = document.createElement("select");
  el.setAttribute("data-testid", testId);
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    el.appendChild(node);
  }
  el.value = value;
  return el;
}

/** Open the builder. Returns a handle whose `close` is idempotent. */
export function openTaskQueryBuilder(options: Options): QueryBuilderHandle {
  let inserted = false;

  const modal = openModal({
    // A dimmed, viewport-spanning backdrop that centers the dialog. Without a
    // class the backdrop is an unstyled zero-size div, so the builder rendered
    // at the top-left corner of the page with no chrome — the defect this closes.
    backdropClass: "cm-task-query-builder-backdrop",
    onDismiss: () => {
      modal.close();
      if (!inserted) options.onCancel?.();
    },
    onEnter: (e: KeyboardEvent) => {
      e.preventDefault();
      insert();
    },
  });

  const surface = document.createElement("div");
  surface.className = "cm-task-query-builder";
  surface.setAttribute("role", "dialog");
  surface.setAttribute("aria-label", i18n.t("editor.slash.taskQuery"));
  surface.setAttribute("data-testid", "editor.task-query-builder");

  const status = select(
    [
      { value: "todo", label: i18n.t("tasks.builder.statusTodo") },
      { value: "done", label: i18n.t("tasks.builder.statusDone") },
      { value: "any", label: i18n.t("tasks.builder.any") },
    ],
    DEFAULT_CHOICE.status,
    "editor.task-query-builder.status",
  );
  const due = select(
    [
      { value: "any", label: i18n.t("tasks.builder.any") },
      { value: "overdue", label: i18n.t("tasks.filter.overdue") },
      { value: "today", label: i18n.t("tasks.filter.today") },
      { value: "week", label: i18n.t("tasks.filter.upcoming") },
      { value: "none", label: i18n.t("tasks.builder.noDueDate") },
    ],
    DEFAULT_CHOICE.due,
    "editor.task-query-builder.due",
  );
  const priority = select(
    [
      { value: "any", label: i18n.t("tasks.builder.any") },
      { value: "highest", label: "highest" },
      { value: "high", label: "high" },
      { value: "medium", label: "medium" },
      { value: "low", label: "low" },
      { value: "lowest", label: "lowest" },
    ],
    DEFAULT_CHOICE.priority,
    "editor.task-query-builder.priority",
  );
  const sort = select(
    [
      { value: "due", label: i18n.t("tasks.builder.sortDue") },
      { value: "priority", label: i18n.t("tasks.builder.sortPriority") },
      { value: "path", label: i18n.t("tasks.builder.sortPath") },
    ],
    DEFAULT_CHOICE.sort,
    "editor.task-query-builder.sort",
  );

  const path = document.createElement("input");
  path.type = "text";
  path.setAttribute("data-testid", "editor.task-query-builder.path");
  const tag = document.createElement("input");
  tag.type = "text";
  tag.setAttribute("data-testid", "editor.task-query-builder.tag");

  surface.appendChild(field(i18n.t("tasks.builder.status"), status, "editor.task-query-builder.row.status"));
  surface.appendChild(field(i18n.t("tasks.builder.due"), due, "editor.task-query-builder.row.due"));
  surface.appendChild(field(i18n.t("tasks.builder.folder"), path, "editor.task-query-builder.row.path"));
  surface.appendChild(field(i18n.t("tasks.builder.tag"), tag, "editor.task-query-builder.row.tag"));
  surface.appendChild(
    field(i18n.t("tasks.builder.priority"), priority, "editor.task-query-builder.row.priority"),
  );
  surface.appendChild(field(i18n.t("tasks.builder.sort"), sort, "editor.task-query-builder.row.sort"));

  // A live preview of the canonical text. The builder teaches the roster by
  // showing what it wrote — which is the whole answer to "English-only".
  const preview = document.createElement("pre");
  preview.className = "cm-task-query-builder-preview";
  preview.setAttribute("data-testid", "editor.task-query-builder.preview");
  surface.appendChild(preview);

  const current = (): QueryBuilderChoice => ({
    status: status.value as QueryBuilderChoice["status"],
    due: due.value as QueryBuilderChoice["due"],
    path: path.value,
    tag: tag.value,
    priority: priority.value as QueryBuilderChoice["priority"],
    sort: sort.value as QueryBuilderChoice["sort"],
    limit: 0,
  });

  const refresh = (): void => {
    preview.textContent = buildQueryText(current());
  };
  for (const control of [status, due, priority, sort]) {
    control.addEventListener("change", refresh);
  }
  for (const control of [path, tag]) control.addEventListener("input", refresh);
  refresh();

  function insert(): void {
    if (inserted) return;
    inserted = true;
    const block = buildQueryBlock(current());
    modal.close();
    options.onInsert(block);
  }

  const actions = document.createElement("div");
  actions.className = "cm-task-query-builder-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.setAttribute("data-testid", "editor.task-query-builder.cancel");
  cancel.textContent = i18n.t("common.cancel");
  cancel.addEventListener("click", () => {
    modal.close();
    if (!inserted) options.onCancel?.();
  });
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.setAttribute("data-testid", "editor.task-query-builder.insert");
  confirm.textContent = i18n.t("tasks.builder.insert");
  confirm.addEventListener("click", insert);
  actions.appendChild(cancel);
  actions.appendChild(confirm);
  surface.appendChild(actions);

  modal.backdrop.appendChild(surface);
  // Trap on the inner surface, not the backdrop, so a backdrop click still
  // dismisses — the card-modal convention this repo already uses.
  modal.installTrap(surface, status);

  return { close: () => modal.close() };
}
