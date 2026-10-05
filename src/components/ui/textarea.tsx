import { cn } from "./cn";
import { fieldClassName } from "./input";

export function Textarea({ className, rows = 4, ...props }: React.ComponentProps<"textarea">) {
  return <textarea rows={rows} className={cn(fieldClassName, "min-h-20 resize-y py-2.5 leading-6", className)} {...props} />;
}
