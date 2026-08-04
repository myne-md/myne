// Display formatters for the attachments library (MYND-170). Pure, no IPC.

import { dateTimeDisplay, formatInstant } from "../../lib/datetimeFormat";

/**
 * Human-readable byte size — binary units (KiB/MiB), one decimal above
 * 1 KiB, integer bytes below. Matches the 64 MiB cap's binary basis
 * (`MAX_ATTACHMENT_LEN`). Sentence-case unit suffixes, space-separated.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * Short calendar date for a UNIX-seconds timestamp (the catalog's
 * `created_at`). Locale-aware short form (e.g. "Jun 8, 2026"); no time
 * component — the library lists are date-granular.
 */
export function formatCreatedAt(
  unixSeconds: number,
  display = dateTimeDisplay(),
): string {
  // myne#279: an attachment's `created_at` is UNIX seconds — a real moment on
  // the timeline — so this is one of the two places the display timezone
  // genuinely converts, rather than a zone-free wall-clock reading.
  return formatInstant(unixSeconds * 1000, display);
}

/**
 * `M:SS` clock for a seconds value — the audio player's elapsed/total readout
 * and the recording bar's elapsed timer (MYND-259). Negative/NaN clamps to 0.
 */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** Broad type bucket for filtering + the type label / thumbnail choice. */
export type AttachmentKind = "image" | "pdf" | "audio" | "other";

/** Classify a catalog content-type into a coarse filter bucket. */
export function kindOf(contentType: string): AttachmentKind {
  if (contentType === "application/pdf") return "pdf";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  return "other";
}

/**
 * Short, human type label for a content-type (the tile/row "type" cell).
 * Image subtypes collapse to their uppercased extension-ish token
 * ("PNG", "JPEG", "SVG"); PDF is "PDF"; anything else shows the raw
 * subtype. Sentence-case is not applied to these — they are format
 * acronyms, conventionally uppercase.
 */
export function typeLabel(contentType: string): string {
  switch (contentType) {
    case "image/png":
      return "PNG";
    case "image/jpeg":
      return "JPEG";
    case "image/gif":
      return "GIF";
    case "image/webp":
      return "WebP";
    case "image/svg+xml":
      return "SVG";
    case "application/pdf":
      return "PDF";
    default: {
      const slash = contentType.indexOf("/");
      return slash === -1
        ? contentType.toUpperCase()
        : contentType.slice(slash + 1).toUpperCase();
    }
  }
}
