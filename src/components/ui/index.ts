/**
 * PACT UI primitives. Import from "@/components/ui".
 *
 * Files with interactive behaviour are Client Components ("use client" in the file itself);
 * everything else renders on the server. Both kinds can be imported from this barrel in either
 * environment.
 */
export { cn } from "./cn";
export { STATUS_TONES, TONE_CLASSES, type StatusTone } from "./tone";
export {
  clamp01,
  formatPercent,
  formatRelativeTime,
  formatUtcDateTime,
  splitMoney,
  toEpochMs,
  truncateMiddle,
  type MoneyParts,
} from "./format";

export { Button, LinkButton, buttonVariants, type ButtonProps, type ButtonVariantProps, type LinkButtonProps } from "./button";
export { Badge, type BadgeProps } from "./badge";
export { StatusPill, type StatusPillProps } from "./status-pill";
export {
  CHECK_RESULT_LABEL,
  CHECK_RESULT_TONE,
  DEAL_STATUS_TONE,
  DealStatusPill,
  PAYMENT_STATUS_TONE,
  PaymentStatusPill,
  POLICY_OUTCOME_LABEL,
  POLICY_OUTCOME_TONE,
  VERIFICATION_DECISION_LABEL,
  VERIFICATION_DECISION_TONE,
  paymentRailSteps,
  type DealStatusPillProps,
  type PaymentRailInput,
  type PaymentStatusPillProps,
} from "./status";
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, type CardProps, type CardTitleProps } from "./card";
export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  type DialogContentProps,
} from "./dialog";
export {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  type SheetContentProps,
  type SheetSide,
} from "./sheet";
export { Tabs, TabsContent, TabsList, TabsTrigger, type TabsListProps } from "./tabs";
export { Tooltip, type TooltipProps } from "./tooltip";
export { Popover, PopoverAnchor, PopoverClose, PopoverContent, PopoverTrigger } from "./popover";
export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  type DropdownMenuItemProps,
} from "./dropdown-menu";
export { Input, fieldClassName } from "./input";
export { Textarea } from "./textarea";
export { Label } from "./label";
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  type SelectTriggerProps,
} from "./select";
export { Switch } from "./switch";
export { Slider, type SliderProps } from "./slider";
export { Checkbox } from "./checkbox";
export { Separator, type SeparatorProps } from "./separator";
export { Skeleton } from "./skeleton";
export { Spinner, type SpinnerProps } from "./spinner";
export { EmptyState, type EmptyStateProps } from "./empty-state";
export { Callout, type CalloutProps, type CalloutTone } from "./callout";
export { Kbd } from "./kbd";
export { Money, type MoneyProps } from "./money";
export { MonoId, type MonoIdProps } from "./mono-id";
export { RelativeTime, type RelativeTimeProps } from "./relative-time";
export { STEP_STATES, Stepper, type StepState, type StepperProps, type StepperStep } from "./stepper";
export { ConfidenceBar, type ConfidenceBarProps } from "./confidence-bar";
export { KeyValue, KeyValueList, type KeyValueListProps, type KeyValueProps } from "./key-value";
export { Toaster } from "./toaster";
export { toast } from "sonner";
export {
  AG_THEME_ATTRIBUTE,
  THEME_ATTRIBUTE,
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
  THEMES,
  isTheme,
  themeInitScript,
  type Theme,
} from "./theme";
export { ThemeSync, useTheme, type UseTheme } from "./use-theme";
export { useHydrated } from "./use-hydrated";
