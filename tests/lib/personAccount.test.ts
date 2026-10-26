// The person account number's DISPLAY half (myne-md/myne#911).
//
// The derivation is pinned in Rust (`protocol::account_number_from_person_id`,
// `person-account-number` vectors). What is pinned here is the part a client
// owns: the display grouping, and the fact that all three clients read it from
// one module rather than from copies that can drift.

import { describe, expect, it } from "vitest";

import {
  formatAccountNumberInput,
  formatPersonAccountNumber,
  PERSON_ACCOUNT_CANONICAL_LEN,
  PERSON_ACCOUNT_DISPLAY_LEN,
} from "@myne/client-core/person-account";

// Pinned by the Rust vector `person-account-number/v0.1/derive-known-phrase`.
const VECTOR_CANONICAL = "Y3P0BP10A70AW68EYWAZ";
const VECTOR_DISPLAY = "MY-Y3P0-BP10-A70A-W68E-YWAZ";

describe("formatPersonAccountNumber", () => {
  it("renders the pinned vector's canonical form as its display form", () => {
    expect(formatPersonAccountNumber(VECTOR_CANONICAL)).toBe(VECTOR_DISPLAY);
  });

  it("produces exactly the canonical 20 and display 27 characters", () => {
    const display = formatPersonAccountNumber(VECTOR_CANONICAL);
    expect(display.length).toBe(PERSON_ACCOUNT_DISPLAY_LEN);
    // The body after the prefix and separators is the canonical form itself.
    expect(display.slice(3).replace(/-/g, "").length).toBe(PERSON_ACCOUNT_CANONICAL_LEN);
  });

  it("groups a canonical body that STARTS WITH M by fours, not by the typing mask", () => {
    // The trap: `formatAccountNumberInput` treats a leading `M` as the user
    // typing the `MY` prefix, so a canonical beginning with `M` there yields
    // "MN-PQRS-…" with no prefix at all. A number handed to us by the Rust
    // derivation must not be read that way.
    const canonical = "MNPQRSTVWXYZ01234567";
    expect(formatPersonAccountNumber(canonical)).toBe("MY-MNPQ-RSTV-WXYZ-0123-4567");
    expect(formatAccountNumberInput(canonical)).toBe("MN-PQRS-TVWX-YZ01-2345-67");
  });

  it("accepts its own output back (idempotent) and stays empty for empty input", () => {
    expect(formatPersonAccountNumber(VECTOR_DISPLAY)).toBe(VECTOR_DISPLAY);
    expect(formatPersonAccountNumber(VECTOR_CANONICAL.toLowerCase())).toBe(VECTOR_DISPLAY);
    expect(formatPersonAccountNumber("")).toBe("");
  });
});

describe("the display has one implementation for every client", () => {
  it("desktop's shim and mobile's shim are the same functions, not copies", () => {
    // This is the acceptance criterion "the same phrase yields the same number
    // on desktop, mobile and web" made mechanical at the half a client owns.
    // Function IDENTITY, not equal output: two copies that agree today would
    // pass an output comparison and drift tomorrow.
    expect(desktopShim.formatPersonAccountNumber).toBe(formatPersonAccountNumber);
    expect(desktopShim.formatAccountNumberInput).toBe(formatAccountNumberInput);
    expect(mobileShim.formatPersonAccountNumber).toBe(formatPersonAccountNumber);
    expect(mobileShim.formatAccountNumberInput).toBe(formatAccountNumberInput);
  });
});

// Static imports of the two client shims, so a shim that stopped re-exporting
// fails to resolve rather than failing a runtime assertion.
import * as desktopShim from "../../src/lib/account-number-format";
import * as mobileShim from "../../mobile/src/lib/account-number-format";
