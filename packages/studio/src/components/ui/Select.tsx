/**
 * Select: Base UI select in Input's box. The trigger keeps `role="combobox"`, which both hotkey selector
 * lists match. Options are data, not children, so typeahead and the value display can read labels.
 */

import { Select as BaseSelect } from "@base-ui/react/select";
import { cn } from "./cn";
import { fieldBase, fieldSizes, type FieldSize } from "./Input";
import { menuItemBase, POPUP_LAYER, popupSurface } from "./Menu";
import type { PreviewState } from "./Button";

export interface SelectOption {
  label: string;
  value: string;
  /** Offered but not choosable; the label stays visible so the reason stays visible too. */
  disabled?: boolean;
}

export interface SelectProps {
  /** Accessible name for the trigger. */
  label: string;
  value: string;
  options: SelectOption[];
  /** Called when a different option is chosen. */
  onCommit: (next: string) => void;
  disabled?: boolean;
  /** `sm` in panels (default), `md` in window forms. */
  size?: FieldSize;
  className?: string;
  "data-preview-state"?: PreviewState;
}

export function Select({
  label,
  value,
  options,
  onCommit,
  disabled,
  size = "sm",
  className,
  "data-preview-state": previewState,
}: SelectProps) {
  return (
    <BaseSelect.Root
      value={value}
      disabled={disabled}
      items={options}
      onValueChange={(next) => {
        const chosen = String(next);
        if (chosen === value) return;
        onCommit(chosen);
      }}
    >
      <BaseSelect.Trigger
        aria-label={label}
        className={cn(
          fieldBase,
          fieldSizes[size],
          "w-full cursor-pointer justify-between text-left disabled:cursor-not-allowed disabled:opacity-50",
          "data-[popup-open]:border-border-strong",
          className,
        )}
        data-preview-state={previewState}
      >
        <BaseSelect.Value className="truncate" />
        <BaseSelect.Icon className="shrink-0 text-fg-3" aria-hidden="true">
          <svg width="8" height="5" viewBox="0 0 8 5" fill="none">
            <path
              d="M1 1L4 4L7 1"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </BaseSelect.Icon>
      </BaseSelect.Trigger>

      <BaseSelect.Portal>
        {/* Above the dock's always-rendered panel overlays (z-1) and the Settings dialog (z-100). */}
        <BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} className={POPUP_LAYER}>
          <BaseSelect.Popup
            className={cn(popupSurface, "min-w-[var(--anchor-width)] p-1 shadow-pop")}
          >
            <BaseSelect.List>
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className={cn(menuItemBase, "justify-start gap-2 data-[selected]:font-medium")}
                >
                  <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden>
                    <BaseSelect.ItemIndicator>✓</BaseSelect.ItemIndicator>
                  </span>
                  <BaseSelect.ItemText className="truncate">{option.label}</BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
