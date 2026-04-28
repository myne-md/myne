interface MyneMarkProps {
  size?: number;
}

// Placeholder mark — two intersecting strokes forming an "M". Replaced with
// the brand-final mark before ship (see docs/design/README.md "Caveats").
export function MyneMark({ size = 24 }: MyneMarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="6" fill="var(--ink-1)" />
      <path
        d="M8 22 V10 L16 18 L24 10 V22"
        stroke="var(--paper)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
