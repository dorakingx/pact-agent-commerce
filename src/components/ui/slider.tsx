"use client";

import { useState } from "react";
import { Slider as SliderPrimitive } from "radix-ui";
import { cn } from "./cn";

export interface SliderProps extends React.ComponentProps<typeof SliderPrimitive.Root> {
  /** Accessible name for each thumb, in order. Required because thumbs have no visible label. */
  thumbLabels: readonly string[];
  /** Human-readable value for assistive technology, e.g. `(v) => formatMoney(v)`. */
  formatValue?: (value: number) => string;
}

/** Range input. One thumb per entry in `value` / `defaultValue`. */
export function Slider({
  thumbLabels,
  formatValue,
  className,
  value,
  defaultValue,
  onValueChange,
  ...props
}: SliderProps) {
  // Mirrors the uncontrolled value so `aria-valuetext` stays correct while the user drags.
  const [uncontrolled, setUncontrolled] = useState<number[]>(defaultValue ?? [props.min ?? 0]);
  const values = value ?? uncontrolled;
  return (
    <SliderPrimitive.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next) => {
        setUncontrolled(next);
        onValueChange?.(next);
      }}
      className={cn(
        "relative flex h-5 w-full touch-none items-center select-none data-[disabled]:opacity-50 pointer-coarse:h-11",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-subtle-strong">
        <SliderPrimitive.Range className="absolute h-full bg-accent" />
      </SliderPrimitive.Track>
      {values.map((v, i) => (
        <SliderPrimitive.Thumb
          key={i}
          aria-label={thumbLabels[i] ?? thumbLabels[0]}
          aria-valuetext={formatValue ? formatValue(v) : undefined}
          className="block size-[18px] rounded-full border-2 border-accent bg-surface shadow-[0_1px_2px_rgb(11_18_32/0.2)] transition-transform duration-150 ease-out focus-ring hover:scale-110 pointer-coarse:size-6"
        />
      ))}
    </SliderPrimitive.Root>
  );
}
