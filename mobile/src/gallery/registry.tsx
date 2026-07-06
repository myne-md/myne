import type { Section } from "./types";
import { onboardingScreens } from "../screens/onboarding";
import { recoverScreens } from "../screens/recover";
import { unlockScreens } from "../screens/unlock";
import { notesScreens } from "../screens/notes";
import { workspaceScreens } from "../screens/workspace";
import { multivaultScreens } from "../screens/multivault";
import { conflictScreens } from "../screens/conflict";
import { syncScreens } from "../screens/sync";
import { organizeScreens } from "../screens/organize";
import { panelScreens } from "../screens/panel";
import { shareScreens } from "../screens/share";
import { editorScreens } from "../screens/editor";
import { settingsScreens } from "../screens/settings";
import { backupScreens } from "../screens/backup";
import { importScreens } from "../screens/importing";
import { systemScreens } from "../screens/system";
import { ipadScreens } from "../ipad";

/**
 * The design board, section by section, in the bundle's order. Each screen
 * module exports an array of ScreenDef. Phone sections apply to ios+android;
 * the iPad section is platforms:["ipad"] and only shows under the iPad toggle.
 */
export const SECTIONS: Section[] = [
  { title: "Onboarding & vault creation", prefix: "OB", screens: onboardingScreens },
  { title: "Restore from recovery", prefix: "RC", screens: recoverScreens },
  { title: "Unlock", prefix: "UN", screens: unlockScreens },
  { title: "Notes & reading", prefix: "", screens: notesScreens },
  { title: "Editor, search, graph & settings", prefix: "", screens: workspaceScreens },
  { title: "Multi-vault", prefix: "MV", screens: multivaultScreens },
  { title: "Conflicts", prefix: "CF", screens: conflictScreens },
  { title: "Sync", prefix: "SY", screens: syncScreens },
  { title: "Organize notes", prefix: "NO", screens: organizeScreens },
  { title: "Right panel", prefix: "RP", screens: panelScreens },
  { title: "Share & export", prefix: "SX", screens: shareScreens },
  { title: "Editor surfaces", prefix: "ED", screens: editorScreens },
  { title: "Settings", prefix: "ST", screens: settingsScreens },
  { title: "Backup", prefix: "BK", screens: backupScreens },
  { title: "Import", prefix: "IM", screens: importScreens },
  { title: "System states", prefix: "SYS", screens: systemScreens },
  { title: "iPad · workspace shell", prefix: "WS", screens: ipadScreens },
];
