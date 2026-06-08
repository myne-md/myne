// Display-formatter tests for the attachments library (MYND-170).

import { describe, expect, it } from "vitest";
import {
  formatBytes,
  kindOf,
  typeLabel,
} from "../../src/components/attachments/format";

describe("formatBytes", () => {
  it("renders bytes below 1 KiB as integer bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("renders KiB / MiB on a binary basis", () => {
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 * 1024)).toBe("1 MiB");
    expect(formatBytes(64 * 1024 * 1024)).toBe("64 MiB");
  });

  it("drops the decimal at or above 10 of a unit", () => {
    expect(formatBytes(10 * 1024)).toBe("10 KiB");
    expect(formatBytes(Math.round(10.4 * 1024))).toBe("10 KiB");
  });
});

describe("kindOf", () => {
  it("buckets content-types into image / pdf / other", () => {
    expect(kindOf("image/png")).toBe("image");
    expect(kindOf("image/svg+xml")).toBe("image");
    expect(kindOf("application/pdf")).toBe("pdf");
    expect(kindOf("application/octet-stream")).toBe("other");
  });
});

describe("typeLabel", () => {
  it("maps known types to short acronyms", () => {
    expect(typeLabel("image/png")).toBe("PNG");
    expect(typeLabel("image/jpeg")).toBe("JPEG");
    expect(typeLabel("image/webp")).toBe("WebP");
    expect(typeLabel("image/svg+xml")).toBe("SVG");
    expect(typeLabel("application/pdf")).toBe("PDF");
  });

  it("falls back to the uppercased subtype for unknown types", () => {
    expect(typeLabel("application/zip")).toBe("ZIP");
  });
});
