import type { ReactNode } from "react";
import type { Platform } from "../platform/PlatformContext";
import { IOSFrame } from "./IOSFrame";
import { AndroidFrame } from "./AndroidFrame";
import { IPadFrame } from "./IPadFrame";

export { IOSFrame } from "./IOSFrame";
export { AndroidFrame } from "./AndroidFrame";
export { IPadFrame } from "./IPadFrame";
export { GlassPill, GlassIconButton } from "./glass";
export { IOSStatusBar, AndroidStatusBar } from "./StatusBars";
export { IOSKeyboard, AndroidKeyboard } from "./Keyboards";

/**
 * Unified device frame — renders the correct bezel for the platform. Phone
 * platforms (ios/android) take `keyboard`; iPad takes `orientation`.
 */
export function DeviceFrame({
  platform,
  children,
  dark = false,
  keyboard = false,
  orientation = "portrait",
}: {
  platform: Platform;
  children: ReactNode;
  dark?: boolean;
  keyboard?: boolean;
  orientation?: "portrait" | "landscape";
}) {
  if (platform === "android") {
    return (
      <AndroidFrame dark={dark} keyboard={keyboard}>
        {children}
      </AndroidFrame>
    );
  }
  if (platform === "ipad") {
    return (
      <IPadFrame dark={dark} orientation={orientation}>
        {children}
      </IPadFrame>
    );
  }
  return (
    <IOSFrame dark={dark} keyboard={keyboard}>
      {children}
    </IOSFrame>
  );
}
