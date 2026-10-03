/**
 * The caption glyphs of the Windows custom frame (home_page/home.css: 10 px
 * shapes with a 1 px stroke, `currentColor`), drawn as the same SVG so the
 * Studio header and the Projects page cannot drift.
 */

import type { SVGProps } from "react";

interface CaptionIconProps extends Omit<SVGProps<SVGSVGElement>, "viewBox"> {
  /** Glyph size in px; the Projects page draws its caption glyphs at 10-12 px. */
  size?: number;
}

function Base({ size = 12, children, ...props }: CaptionIconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Minimize: the Projects page 10 px bar. */
export function CaptionMinimize({ size = 12, ...props }: CaptionIconProps) {
  return (
    <Base size={size} {...props}>
      <path d="M1 6h10" />
    </Base>
  );
}

/** Maximize: the Projects page 10×10 outline (the window is zoomed out). */
export function CaptionMaximize({ size = 12, ...props }: CaptionIconProps) {
  return (
    <Base size={size} {...props}>
      <rect x={1} y={1} width={10} height={10} />
    </Base>
  );
}

/**
 * Restore: the Projects page pair — two aligned 8×8 px outlined squares, the
 * back one 2 px up-right of the front one. The front square is filled with
 * the button background so it masks the back one where they overlap.
 */
export function CaptionRestore({ size = 12, ...props }: CaptionIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x={4} y={1} width={7.5} height={7.5} />
      <rect x={1} y={3.5} width={7.5} height={7.5} fill="var(--color-bg-1)" stroke="none" />
      <rect x={1} y={3.5} width={7.5} height={7.5} />
    </svg>
  );
}

/** Close: the Projects page two 12 px strokes. */
export function CaptionClose({ size = 12, ...props }: CaptionIconProps) {
  return (
    <Base size={size} {...props}>
      <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" />
    </Base>
  );
}
