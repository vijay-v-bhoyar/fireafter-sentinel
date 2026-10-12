/** Fixed public explanations; source/provider exception text is never returned. */
const failures = {
 MODEL_CONTEXT_UNSUPPORTED: 'The source exceeds the configured model context. Source text was retained in full; interpretation stopped. Ask the coordinator to review source size and model capacity before another run.',
 RETENTION_UNSUPPORTED: 'This run cannot use the source retention setting. Ask the coordinator to select a permitted source; restricted text will not be copied into a model request.',
 CORPUS_INCOMPLETE: 'The recorded example lacks complete source evidence. Ask the coordinator to restore its permitted corpus before another run.',
 RETRIEVAL_INCOMPLETE: 'The source check is incomplete. Successful evidence was retained, but interpretation stopped. Review the source failures before another run.',
 SOURCE_TEXT_UNAVAILABLE: 'Source text is unavailable for interpretation. Review its availability and retention permission before another run.',
 CITATION_AMBIGUOUS: 'An interpretation could not be linked to one exact source passage. It remains unaccepted and needs review.',
 CITATION_INVALID: 'An interpretation failed its source-passage check. It remains unaccepted and needs review.',
 ENTITY_UNSUPPORTED: 'An interpretation named an entity that its cited passage does not support. It remains unaccepted and needs review.',
 CHANGE_COVERAGE_INCOMPLETE: 'The comparison did not cover every selected source change. Approval remains blocked pending review.',
 CHANGE_REFERENCE_INVALID: 'The comparison contains an invalid evidence reference. Approval remains blocked pending review.',
 CHANGE_IDENTITY_UNRESOLVED: 'The comparison could not establish a consistent source identity. Approval remains blocked pending review.',
 CHANGE_NOT_REVISION: 'The comparison treated a new source as a revision. The interpretation remains unaccepted.',
 CHANGE_TEXT_UNAVAILABLE: 'The comparison lacks required earlier source text. Review the retained evidence before another run.',
 SOURCE_CONFIGURATION_CHANGED: 'Source configuration changed during this run. Review the current registry before starting new work.',
 EVIDENCE_CHANGED: 'Evidence changed during this run. Review the current evidence before starting new work.',
} as const;

export function workerVerificationFailureCode(error: unknown): string {
 if(error instanceof Error && Object.hasOwn(failures,error.message))return error.message.toLowerCase();
 return 'verification_failed';
}

export function runFailureMessage(code: string): string {
 const key=code.toUpperCase();
 if(Object.hasOwn(failures,key))return failures[key as keyof typeof failures];
 if(code==='provider_budget_stopped'||code==='run_budget_stopped')return 'The run reached its usage limit. Reserved usage remains recorded; ask the coordinator to review the budget.';
 return 'The run did not finish. Review its retained evidence and usage before starting new work; an incomplete check cannot support approval.';
}
