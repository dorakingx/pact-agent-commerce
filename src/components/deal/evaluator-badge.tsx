import { Binary, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui";
import type { Evaluator } from "@/lib/domain/schemas";

/** Who judges a condition: code that measures, or a model that reads. */
export function EvaluatorBadge({ evaluator, className }: { evaluator: Evaluator; className?: string }) {
  return evaluator === "ai" ? (
    <Badge tone="info" className={className} data-evaluator="ai" title="Judged by the AI verifier. Its result is a proposal: the decision rule is deterministic.">
      <Sparkles aria-hidden="true" />
      AI
    </Badge>
  ) : (
    <Badge tone="neutral" variant="outline" className={className} data-evaluator="deterministic" title="Measured by deterministic code. No model is involved.">
      <Binary aria-hidden="true" />
      Deterministic
    </Badge>
  );
}
