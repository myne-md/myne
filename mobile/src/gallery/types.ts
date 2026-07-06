import type { FC } from "react";
import type { Platform } from "../platform/PlatformContext";

/**
 * A single design-board entry. Each screen module exports an array of these;
 * the registry concatenates them. The gallery renders the component inside the
 * selected device frame at the selected theme.
 */
export interface ScreenDef {
  /** Design ID, e.g. "OB-02", "05", "ST-07". */
  id: string;
  /** Human label from the board, e.g. "Create password". */
  label: string;
  /** The screen component (frame-agnostic; renders `.m-screen` content). */
  Component: FC;
  /** Show the software keyboard in the device frame. */
  keyboard?: boolean;
  /** Restrict to specific platforms (default: ios + android). */
  platforms?: Platform[];
  /** iPad-only orientation hint. */
  orientation?: "portrait" | "landscape";
}

export interface Section {
  /** Section title from the board. */
  title: string;
  /** Short prefix, e.g. "OB". */
  prefix: string;
  screens: ScreenDef[];
}
