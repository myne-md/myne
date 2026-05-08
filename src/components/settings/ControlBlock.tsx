import type { ReactNode } from "react";
import { BLOCK_STYLE, HELPER_STYLE, LABEL_STYLE } from "./panel-styles";

interface ControlBlockProps {
  label: string;
  helper: string;
  control: ReactNode;
}

export function ControlBlock({ label, helper, control }: ControlBlockProps) {
  return (
    <div style={BLOCK_STYLE}>
      <span style={LABEL_STYLE}>{label}</span>
      {control}
      <p style={HELPER_STYLE}>{helper}</p>
    </div>
  );
}
