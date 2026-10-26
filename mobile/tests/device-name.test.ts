// @vitest-environment jsdom
//
// The suggested device name is chosen from the size class (myne-md/myne#918).
//
// The OS constant reports `ios` for both an iPhone and an iPad, so the only
// signal is the layout. That signal used to be `sizeClass !== "compact"`, which
// classified the folded band as a tablet and prefilled "iPad" on an unfolded
// phone. The matrix below pins both halves: the wording per token, and the fact
// that the band answers the phone wording.

import { describe, expect, it } from "vitest";
import i18n from "@myne/i18n";

import { deviceNameForPlatform } from "../src/lib/device-name";
import { isRegularSizeClass } from "../src/formfactor/SizeClassContext";

describe("the suggested device name", () => {
  it("calls an iPhone an iPhone and an iPad an iPad", async () => {
    await i18n.changeLanguage("en");
    expect(deviceNameForPlatform("ios", false)).toBe(i18n.t("sync.devices.platform.ios"));
    expect(deviceNameForPlatform("ios", true)).toBe(i18n.t("sync.devices.platform.ipad"));
  });

  it("calls an Android phone a phone and an Android tablet a tablet", async () => {
    await i18n.changeLanguage("en");
    expect(deviceNameForPlatform("android", false)).toBe(i18n.t("sync.devices.platform.android"));
    expect(deviceNameForPlatform("android", true)).toBe(
      i18n.t("sync.devices.platform.androidTablet"),
    );
  });

  it("treats the folded band as a phone for this purpose", () => {
    // The call site passes `isRegularSizeClass(computeSizeClass())`, so this is
    // the arm the band takes. A tablet word here is the defect the fix removed.
    expect(isRegularSizeClass("compactWide")).toBe(false);
    expect(isRegularSizeClass("medium")).toBe(true);
  });
});
