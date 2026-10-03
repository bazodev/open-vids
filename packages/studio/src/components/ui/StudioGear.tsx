/**
 * The app's one Settings gear (Phosphor "Gear" regular, an 8-tooth filled cog)
 * in `currentColor`: the same path data as the Projects page
 * (`ic("settings")` in home_page/shared.js), so the Studio header, its app menu
 * and the Settings nav draw the same shape. Chosen on a headless-Chrome
 * contact sheet for crisp 14-16 px rendering on the dark title bar at
 * 1x/1.75x/4x; it is also the gear Studio already uses elsewhere
 * (SystemIcons Settings).
 */

import type { SVGProps } from "react";

interface StudioGearProps extends Omit<SVGProps<SVGSVGElement>, "viewBox"> {
  /** Glyph size in px. */
  size?: number;
}

/**
 * The app's one Settings gear, scaled to the header's icon size: Phosphor
 * "Gear" regular (256-grid scaled to this 24-grid), a filled 8-tooth cog in
 * `currentColor` so it follows the surrounding ink in either theme. Render at
 * a whole-pixel size (16 px in the title bar); the filled silhouette with
 * `shapeRendering="geometricPrecision"` stays crisp at 1.75x where the old
 * 1.6-stroke outline drew hairlines.
 */
export const STUDIO_GEAR_SIZE = 16;
export function StudioGear({ size = STUDIO_GEAR_SIZE, ...props }: StudioGearProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      shapeRendering="geometricPrecision"
      {...props}
    >
      <path d="M12 7.5a4.5 4.5 0 1 0 4.5 4.5A4.5 4.5 0 0 0 12 7.5Zm0 7.5a3 3 0 1 1 3 -3A3 3 0 0 1 12 15Zm8.25 -2.8q0.01 -0.2 0 -0.4l1.4 -1.75a0.75 0.75 0 0 0 0.14 -0.66a10.05 10.05 0 0 0 -1.02 -2.46a0.75 0.75 0 0 0 -0.56 -0.37l-2.22 -0.25q-0.14 -0.15 -0.28 -0.28L17.44 3.8a0.75 0.75 0 0 0 -0.37 -0.56a10.1 10.1 0 0 0 -2.46 -1.02a0.75 0.75 0 0 0 -0.66 0.14L12.2 3.75Q12 3.75 11.8 3.75L10.05 2.35a0.75 0.75 0 0 0 -0.66 -0.14A10.09 10.09 0 0 0 6.93 3.24a0.75 0.75 0 0 0 -0.37 0.56L6.31 6.03q-0.15 0.14 -0.28 0.28L3.8 6.56a0.75 0.75 0 0 0 -0.56 0.37a10.1 10.1 0 0 0 -1.02 2.46a0.75 0.75 0 0 0 0.14 0.66L3.75 11.8Q3.75 12 3.75 12.2L2.35 13.95a0.75 0.75 0 0 0 -0.14 0.66a10.05 10.05 0 0 0 1.02 2.46a0.75 0.75 0 0 0 0.56 0.37l2.22 0.25q0.14 0.15 0.28 0.28L6.56 20.2a0.75 0.75 0 0 0 0.37 0.56a10.1 10.1 0 0 0 2.46 1.02a0.75 0.75 0 0 0 0.66 -0.14L11.8 20.25q0.2 0.01 0.41 0l1.75 1.4a0.75 0.75 0 0 0 0.66 0.14a10.05 10.05 0 0 0 2.46 -1.02a0.75 0.75 0 0 0 0.37 -0.56l0.25 -2.22q0.15 -0.14 0.28 -0.28L20.2 17.44a0.75 0.75 0 0 0 0.56 -0.37a10.1 10.1 0 0 0 1.02 -2.46a0.75 0.75 0 0 0 -0.14 -0.66Zm-1.51 -0.61a6.93 6.93 0 0 1 0 0.81a0.75 0.75 0 0 0 0.16 0.51l1.33 1.66a8.58 8.58 0 0 1 -0.58 1.41L17.53 16.23a0.75 0.75 0 0 0 -0.48 0.25a6.95 6.95 0 0 1 -0.58 0.58a0.75 0.75 0 0 0 -0.25 0.48l-0.24 2.12a8.56 8.56 0 0 1 -1.41 0.58l-1.66 -1.33a0.75 0.75 0 0 0 -0.47 -0.16h-0.04a6.93 6.93 0 0 1 -0.81 0a0.75 0.75 0 0 0 -0.51 0.16L9.42 20.23a8.58 8.58 0 0 1 -1.41 -0.58L7.77 17.53a0.75 0.75 0 0 0 -0.25 -0.48a6.95 6.95 0 0 1 -0.58 -0.58a0.75 0.75 0 0 0 -0.48 -0.25L4.35 15.99a8.56 8.56 0 0 1 -0.58 -1.41l1.33 -1.66a0.75 0.75 0 0 0 0.16 -0.51a6.93 6.93 0 0 1 0 -0.81a0.75 0.75 0 0 0 -0.16 -0.51L3.77 9.42a8.58 8.58 0 0 1 0.58 -1.41L6.47 7.77a0.75 0.75 0 0 0 0.48 -0.25a6.95 6.95 0 0 1 0.58 -0.58A0.75 0.75 0 0 0 7.77 6.47L8.01 4.35a8.56 8.56 0 0 1 1.41 -0.58l1.66 1.33a0.75 0.75 0 0 0 0.51 0.16a6.93 6.93 0 0 1 0.81 0a0.75 0.75 0 0 0 0.51 -0.16L14.58 3.77a8.58 8.58 0 0 1 1.41 0.58L16.23 6.47a0.75 0.75 0 0 0 0.25 0.48a6.95 6.95 0 0 1 0.58 0.58a0.75 0.75 0 0 0 0.48 0.25l2.12 0.24a8.56 8.56 0 0 1 0.58 1.41l-1.33 1.66A0.75 0.75 0 0 0 18.74 11.59Z" />
    </svg>
  );
}
