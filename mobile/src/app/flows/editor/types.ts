import type { ReactNode } from "react";

export interface NoteEntry {
  id: string;
  title: string;
  snippet: string;
}

export interface OutlineItem {
  level: number;
  text: string;
  /** Char offset of the heading line start, for caret jump. */
  index: number;
}

/** Minimal structural pointer-event shape for the tap/scroll discrimination. */
export type PressEvt = { preventDefault: () => void; clientX: number; clientY: number };

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}
