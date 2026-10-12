export function formatProductPromiseGateIssue(gate) {
  const label = typeof gate?.label === "string" && gate.label.trim()
    ? gate.label.trim()
    : typeof gate?.id === "string" && gate.id.trim()
      ? gate.id.trim()
      : "Product Promise gate";
  const gaps = Array.isArray(gate?.gaps)
    ? gate.gaps.filter((value) => typeof value === "string" && value.trim())
    : [];
  const evidence = Array.isArray(gate?.evidence)
    ? gate.evidence.filter((value) => typeof value === "string" && value.trim())
    : [];
  const nextAction = typeof gate?.nextAction === "string" && gate.nextAction.trim()
    ? gate.nextAction.trim()
    : "Review the Product Promise panel for the required remediation.";

  return [
    `${label} not pass: ${gaps.join(", ") || "no evidence"}`,
    `Evidence: ${evidence.join(" ") || "No supporting evidence was returned."}`,
    `Next action: ${nextAction}`,
  ].join(" ");
}
