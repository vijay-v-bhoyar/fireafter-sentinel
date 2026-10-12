"""Validate the single final planning set; never runs app/provider/database tests.

Usage: python docs/evidence/validate_documents.py
Uses only the Python standard library and read-only Git/source fingerprinting.
Writes only PLANNING_MANIFEST.json and document-validation.json in this project.
"""
from pathlib import Path
import csv
import datetime
import hashlib
import json
import math
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / 'docs/evidence'
MARKDOWN = {
    'README.md', 'BUILD_PLAN.md', 'PROVENANCE.md',
    *('docs/' + name + '.md' for name in [
        'FIREAFTER_BASELINE', 'PRODUCT_STRATEGY', 'PRODUCT_REQUIREMENTS', 'UX_SPEC',
        'ARCHITECTURE', 'DATA_AND_API_CONTRACTS', 'SOURCE_AND_TOOL_CONTRACTS',
        'SECURITY_AND_HUMAN_REVIEW', 'PROJECT_ISOLATION', 'EVALUATION_AND_TEST_PLAN',
        'RED_TEAM_PLAN', 'DOMAIN_DISCOVERY', 'DECISIONS_AND_BUILD_GATE',
        'OPERATIONS_AND_COST_PLAN', 'SUBMISSION_PLAN'])}
CSV_FILES = {'docs/' + name + '.csv' for name in [
    'requirements', 'backlog', 'traceability', 'evaluation_cases',
    'red_team_probes', 'cognitive_demands', 'hackathon_compliance']}
GENERATED = {'docs/PLANNING_MANIFEST.json', 'docs/evidence/document-validation.json'}
EXPECTED = MARKDOWN | CSV_FILES | GENERATED | {
    'docs/evidence/source-baseline.json', 'docs/evidence/validate_documents.py'}
SUPPORTING = {'design/sentinel-workflow.html', '.env.example'}
CHECKS = []


def check(name, errors, details=None):
    CHECKS.append(dict(check=name, outcome='FAIL' if errors else 'PASS',
                       failures=errors, details=details))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def text(name):
    return (ROOT / name).read_text(encoding='utf-8-sig')


def read_csv(name):
    with (ROOT / 'docs' / (name + '.csv')).open(encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        errors = []
        if not reader.fieldnames or len(set(reader.fieldnames)) != len(reader.fieldnames):
            errors.append(name + ': missing or duplicate column header')
        if any(None in row or any(value is None for value in row.values()) for row in rows):
            errors.append(name + ': row width differs from header')
        if errors:
            raise ValueError('; '.join(errors))
        return rows


def ids(value):
    return set(filter(None, value.split(';')))


# Validate only the final planning boundary. Runtime and dependencies are separate.
# Do not recurse over node_modules or reject imported application code.
files = {p.relative_to(ROOT).as_posix() for p in (ROOT / 'docs').rglob('*')
         if p.is_file()}
files |= {p.name for p in ROOT.glob('*.md') if p.name != 'AGENTS.md'}
errors = ['Unexpected planning artifact: ' + n for n in sorted(files - EXPECTED)]
errors += ['Missing planning artifact: ' + n for n in sorted(EXPECTED - files)]
check('Exactly one final planning set; runtime and instructions excluded', errors,
      dict(expected=29, markdown=18, csv=7, json=3, validator=1,
           boundary='docs/ and root planning Markdown; AGENTS.md and runtime excluded'))

requirements = read_csv('requirements')
tasks = read_csv('backlog')
cases = read_csv('evaluation_cases')
probes = read_csv('red_team_probes')
trace = read_csv('traceability')
compliance = read_csv('hackathon_compliance')
demands = read_csv('cognitive_demands')
counts = dict(requirements=len(requirements), tasks=len(tasks),
              evaluation_cases=len(cases), red_team_probes=len(probes),
              cognitive_demand_rows=len(demands), compliance_rows=len(compliance))
rids = {r['requirement_id'] for r in requirements}
tids = {r['task_id'] for r in tasks}
cids = {r['case_id'] for r in cases}
case_map = {r['case_id']: r for r in cases}
task_map = {r['task_id']: r for r in tasks}
errors = []
for data, key, prefix, count, width in [
        (requirements, 'requirement_id', 'SEN-R', 25, 3),
        (tasks, 'task_id', 'SEN-T', 24, 2),
        (cases, 'case_id', 'E', 39, 2), (probes, 'probe_id', 'RT', 24, 2),
        (compliance, 'compliance_id', 'HC', 26, 2)]:
    expected_ids = {prefix + str(i).zfill(width) for i in range(1, count + 1)}
    actual_ids = [r[key] for r in data]
    if set(actual_ids) != expected_ids or len(actual_ids) != count:
        errors.append(key + ': missing/duplicate/unexpected IDs')
if len(demands) != 10 or any(len(row) != 9 for row in demands):
    errors.append('Cognitive demand rows/schema changed')
check('Stable IDs, counts and structured schemas', errors, counts)

errors = []
for data in [tasks, cases, probes]:
    for row in data:
        if ids(row['requirement_ids']) - rids:
            errors.append('Unknown requirement reference: ' + row['requirement_ids'])
for row in probes:
    if ids(row['task_ids']) - tids or ids(row['case_ids']) - cids:
        errors.append(row['probe_id'] + ': unknown task/case')
    if not row['success_oracle'] or not row['guardrail_control']:
        errors.append(row['probe_id'] + ': no independent oracle/control')
# Backlog owns status; the decision register must agree without a second task list here.
progress_paragraph = next((line for line in text('docs/DECISIONS_AND_BUILD_GATE.md').splitlines()
                           if line.startswith('As of ') and 'are IN_PROGRESS;' in line), '')
recorded_active = set(re.findall(r'SEN-T\d{2}', progress_paragraph.split('are IN_PROGRESS;')[0]))
backlog_active = {row['task_id'] for row in tasks if row['status'] == 'IN_PROGRESS'}
if not recorded_active or recorded_active != backlog_active:
    errors.append('Backlog task states disagree with the current decision-register observation')
if any(row['status'] not in {'PLANNED', 'IN_PROGRESS'} for row in tasks):
    errors.append('Task acceptance advanced without recorded full acceptance evidence')
for data, status in [(cases, 'DESIGNED_NO_CORPUS'), (probes, 'DESIGNED_NOT_RUN')]:
    if any(row['status'] != status for row in data):
        errors.append('Runtime completion falsely advanced from ' + status)
check('References, independent oracles and truthful runtime states', errors)

errors, visited, visiting = [], set(), set()


def visit(tid):
    if tid in visiting:
        errors.append('Dependency cycle: ' + tid)
        return
    if tid in visited:
        return
    visiting.add(tid)
    for dep in ids(task_map[tid]['depends_on']):
        if dep not in tids:
            errors.append(tid + ': missing dependency ' + dep)
            continue
        if task_map[dep]['target_date'] > task_map[tid]['target_date']:
            errors.append(tid + ': date precedes dependency ' + dep)
        visit(dep)
    visiting.remove(tid)
    visited.add(tid)


for tid in tids:
    visit(tid)
if 'SEN-T08' not in ids(task_map['SEN-T07']['depends_on']):
    errors.append('Integrated retrieval must follow durable admission')
if any('SEN-T17' not in ids(task_map[t]['depends_on']) for t in ['SEN-T19', 'SEN-T20']):
    errors.append('Observed walkthrough/evaluation must follow usable interface')
check('Single task dependency DAG and consistent acceptance dates', errors,
      dict(visited=len(visited), date_authority='docs/backlog.csv'))

errors = []
checks_defined = set(re.findall(r'\| (CHECK-[A-Z]+) \|', text('docs/EVALUATION_AND_TEST_PLAN.md')))
if {r['requirement_id'] for r in trace} != rids or len(trace) != len(requirements):
    errors.append('Traceability must cover each requirement once')
for row in trace:
    rid = row['requirement_id']
    if 'docs/' + row['specification'] not in MARKDOWN:
        errors.append(rid + ': specification not a final owner document')
    if not row['task_ids'] or row['verification_check'] not in checks_defined:
        errors.append(rid + ': missing owned task/defined check')
    for tid in ids(row['task_ids']):
        if tid not in tids or rid not in ids(task_map[tid]['requirement_ids']):
            errors.append(rid + ': task ownership conflict ' + tid)
    if ids(row['case_ids']) - cids:
        errors.append(rid + ': unknown case')
    for cid in ids(row['case_ids']) & cids:
        if rid not in ids(case_map[cid]['requirement_ids']):
            errors.append(rid + ': case ownership conflict ' + cid)
check('Every requirement has a final specification, owning tasks and defined check', errors)

errors = []
links = {}
obsolete = ['IMPLEMENTATION_SCOPE.md', 'IMPLEMENTATION_BLUEPRINT.md',
            'REVIEW_FEEDBACK_AND_PORTABILITY.md', 'HACKATHON_COMPLIANCE.md',
            'DOCUMENT_REVIEW.md', 'LOOP_BOOTSTRAP_PLAN.md', 'DELIVERY_BACKLOG.md',
            'ROUTING_AND_SCOPE.md', 'HACKATHON_CHANGES.md', 'revision-0.',
            'validate_revision_0_3.py', 'effort-estimate.json', 'moat-blind-grade.json',
            'review-source.json', 'loop-preflight.json', 'docs/strategy/']
for name in sorted(MARKDOWN):
    content = text(name)
    if any(char in content for char in ['\u00c3', '\u00e2', '\u00c2', '\ufffd']):
        errors.append(name + ': corrupted punctuation/encoding')
    if any(token in content for token in obsolete):
        errors.append(name + ': superseded file/version reference')
    if len(re.findall(r'^# ', content, re.M)) != 1:
        errors.append(name + ': expected one document title')
    if sum(1 for line in content.splitlines() if line.startswith('```')) % 2:
        errors.append(name + ': unbalanced fenced block')
    headings = re.findall(r'^## (.+)$', content, re.M)
    if len(headings) != len(set(headings)):
        errors.append(name + ': duplicate section heading')
    if any(line != line.rstrip() for line in content.splitlines()):
        errors.append(name + ': trailing whitespace')
    links[name] = set()
    for ref in re.findall(r'\]\(([^)]+)\)', content):
        reference = ref.strip('<>')
        target, separator, fragment = reference.partition('#')
        if not target or re.match(r'^[a-zA-Z]+://', target):
            continue
        dest = ((ROOT / name).parent / target).resolve()
        if not dest.is_relative_to(ROOT):
            errors.append(name + ': link leaves project ' + ref)
            continue
        relative = dest.relative_to(ROOT).as_posix()
        if relative not in EXPECTED | SUPPORTING or not dest.exists():
            errors.append(name + ': missing/nonfinal link ' + ref)
        elif separator and dest.suffix == '.md':
            anchors = set()
            used = {}
            for heading in re.findall(r'^#{1,6} (.+)$', dest.read_text(encoding='utf-8-sig'), re.M):
                anchor = re.sub(r'[^\w\- ]', '', heading.lower()).replace(' ', '-')
                occurrence = used.get(anchor, 0)
                used[anchor] = occurrence + 1
                anchors.add(anchor if not occurrence else anchor + '-' + str(occurrence))
            if fragment not in anchors:
                errors.append(name + ': missing section anchor ' + ref)
        links[name].add(relative)
for name in sorted(MARKDOWN - {'README.md'}):
    if name not in links['README.md']:
        errors.append('Final document absent from root index: ' + name)
check('Final index coverage, local links, section structure and no stale version references', errors)

errors = []
prototype = ROOT / 'design/sentinel-workflow.html'
if not prototype.is_file() or prototype.stat().st_size == 0:
    errors.append('Started design task lacks its concrete prototype')
ux = text('docs/UX_SPEC.md')
if 'user review remains pending' not in ux.lower() or 'SEN-T05 is IN_PROGRESS' not in ux:
    errors.append('Prototype falsely treated as approved or completed')
if 'have not yet been created' in ux:
    errors.append('Stale prototype status')
if 'Observed local progress' not in text('docs/DECISIONS_AND_BUILD_GATE.md'):
    errors.append('Missing dated partial-build observations')
check('Existing prototype and partial local checks do not imply product acceptance', errors,
      dict(prototype='design/sentinel-workflow.html', user_review='PENDING',
           local_baseline='CHECKS_STARTED_ACCEPTANCE_PENDING'))

errors = []
for name in ['src/lib/sentinel/contracts.ts', 'src/lib/sentinel/evidence.ts', 'src/lib/sentinel/store.ts',
             'supabase/migrations/20261011190000_sentinel_evidence_records.sql']:
    if not (ROOT / name).is_file():
        errors.append('Started records task lacks its concrete implementation: ' + name)
check('Started scoped-record task retains concrete partial implementation', errors,
      dict(task='SEN-T06 IN_PROGRESS', acceptance='PENDING_FULL_COMMAND_AND_TARGET_PROOF'))

errors = []
for name in ['src/lib/sentinel/runs.ts', 'src/lib/sentinel/run-http.ts',
             'src/app/api/sentinel/runs/route.ts', 'src/app/api/sentinel/runs/[id]/route.ts',
             'src/app/api/sentinel/runs/[id]/cancel/route.ts',
             'supabase/migrations/20261011200000_sentinel_run_admission.sql']:
    if not (ROOT / name).is_file():
        errors.append('Started durable-run task lacks implementation: ' + name)
if 'dispatch/reconciliation' not in text('docs/DATA_AND_API_CONTRACTS.md'):
    errors.append('Durable foundation omits remaining dispatch acceptance')
check('Started durable-run task is partial and retains concrete commands', errors,
      dict(task='SEN-T08 IN_PROGRESS', acceptance='PENDING_DISPATCH_PROVIDER_AND_TARGET_PROOF'))

errors = []
for name in ['src/lib/sentinel/changes.ts', 'src/lib/sentinel/change-http.ts',
             'src/app/api/sentinel/changes/route.ts', 'src/lib/sentinel/changes.test.ts',
             'src/lib/sentinel/changes-sql.test.ts',
             'supabase/migrations/20261011232000_sentinel_change_drafts.sql']:
    if not (ROOT / name).is_file():
        errors.append('Started comparison task lacks its concrete implementation: ' + name)
if 'publishChanges' not in text('docs/ARCHITECTURE.md') or 'semanticAccepted=false' not in text('docs/DATA_AND_API_CONTRACTS.md'):
    errors.append('Draft publication must remain distinct from semantic acceptance')
if 'marker resolution' not in text('docs/ARCHITECTURE.md').lower():
    errors.append('Comparison task omits remaining marker-resolution acceptance')
check('Started comparison task retains concrete drafts and pending acceptance', errors,
      dict(task='SEN-T10 IN_PROGRESS', acceptance='PENDING_MODEL_SEMANTIC_MARKER_AND_TARGET_PROOF'))

errors = []
for name in ['src/lib/sentinel/planning.ts', 'src/lib/sentinel/constraints.ts',
             'src/app/api/sentinel/constraints/route.ts', 'src/lib/sentinel/planning.test.ts',
             'src/lib/sentinel/constraints-sql.test.ts',
             'supabase/migrations/20261011234000_sentinel_constraints.sql']:
    if not (ROOT / name).is_file():
        errors.append('Started planning task lacks concrete implementation: ' + name)
if 'authored_constraints_only' not in text('docs/DATA_AND_API_CONTRACTS.md'):
    errors.append('Authored allocation falsely treated as complete evidence/plan approval')
check('Started planning task retains concrete constraints and pending approval', errors,
      dict(task='SEN-T11 IN_PROGRESS', acceptance='PENDING_PERSISTED_EVIDENCE_PLAN_AND_DECISION_PROOF'))

errors = []
for name, stale in [
        ('docs/DATA_AND_API_CONTRACTS.md', 'All Sentinel table/endpoint names below are proposed and currently unimplemented'),
        ('docs/EVALUATION_AND_TEST_PLAN.md', 'none records an executed Sentinel test'),
        ('docs/PRODUCT_REQUIREMENTS.md', 'Other roles cannot record a plan decision')]:
    if stale in text(name):
        errors.append(name + ': contradicts partial implementation or per-action roles')
decision_row = next((line for line in text('docs/PRODUCT_REQUIREMENTS.md').splitlines()
                     if line.startswith('| Decision |')), '')
for clause in ['incident_commander accepts/rejects', 'analyst modifies/annotates',
               'Analyst cannot accept/reject', 'viewer cannot issue review commands']:
    if clause not in decision_row:
        errors.append('Supported-scope decision row lacks explicit per-action rule: ' + clause)
progress = text('docs/DECISIONS_AND_BUILD_GATE.md')
for clause in ['Strict production browser smoke', 'FAIL:', 'Fresh-target integration',
               'NOT_RUN', 'no task has completed acceptance']:
    if clause not in progress:
        errors.append('Observed local progress omits boundary: ' + clause)
check('Partial implementation, observed failures and per-action role statements agree', errors,
      dict(scope='Document consistency only; actual runtime results retain separate receipts'))

errors = []
for name in ['src/lib/sentinel/workspace-client.ts',
             'src/app/api/sentinel/documents/[id]/claims/route.ts',
             'src/components/sentinel/sentinel-evidence.tsx',
             'src/components/sentinel/sentinel-constraints.tsx',
             'src/components/sentinel/sentinel-plan.tsx']:
    if not (ROOT / name).is_file():
        errors.append('Recorded partial UI/claim-route source missing: ' + name)
if task_map['SEN-T17']['status'] != 'IN_PROGRESS':
    errors.append('Reviewer integration source is present but its task is not started')
for clause in ['LOCAL_PROVIDER_', 'claim-list route has local HTTP/helper evidence',
               'no real provider/account/tokenizer or concurrent-session proof']:
    if clause not in progress:
        errors.append('Current verification observation omits: ' + clause)
if 'no real provider/account/tokenizer or concurrent-session proof' not in progress:
    errors.append('Historical full pass incorrectly applied to newer unverified source')
check('Partial reviewer source and historical verification coverage remain distinct', errors,
      dict(task='SEN-T17 IN_PROGRESS', runtime_checks='LOCAL_ONLY_FULL_TARGET_PENDING'))

errors = []
provenance_lines = text('PROVENANCE.md').splitlines()
table_start = next((i for i, line in enumerate(provenance_lines)
                    if line == '| Date | Actual work | Evidence boundary |'), -1)
table_end = table_start + 1
while table_end < len(provenance_lines) and provenance_lines[table_end].startswith('|'):
    table_end += 1
if table_start < 0 or any(line.startswith('| October') or line.startswith('| Pending |')
                         for line in provenance_lines[table_end:]):
    errors.append('Dated provenance rows fall outside the single development-history table')
check('One continuous provenance history without detached version rows', errors,
      dict(scope='Dated history remains separate from the current decision register'))

errors = []
if 'a claim-list HTTP binding, alternate' in text('docs/ARCHITECTURE.md'):
    errors.append('Architecture still treats the existing claim-list binding as absent')
if 'member claim-list HTTP binding remains pending' in text('docs/DATA_AND_API_CONTRACTS.md'):
    errors.append('API specification still treats the existing claim-list binding as absent')
if 'Unsupported feedback fields reject until the separate permissioned feedback capability is integrated' in text('docs/ARCHITECTURE.md'):
    errors.append('Decision contract contradicts the integrated optional feedback wrapper')
if 'Target window' in text('BUILD_PLAN.md'):
    errors.append('Build plan duplicates task scheduling owned by backlog.csv')
for name, stale in [
        ('docs/DATA_AND_API_CONTRACTS.md', 'Optional feedback is deliberately rejected until'),
        ('docs/DATA_AND_API_CONTRACTS.md', 'Briefings and optional feedback integration remain proposed'),
        ('docs/ARCHITECTURE.md', 'actual model comparison remain pending'),
        ('docs/SOURCE_AND_TOOL_CONTRACTS.md', 'One transient retry per retrieval operation'),
        ('docs/SOURCE_AND_TOOL_CONTRACTS.md', 'Retry transient within reserved budget')]:
    if stale in text(name):
        errors.append(name + ': superseded capability/retry statement: ' + stale)
environment_names = set(re.findall(r'^([A-Z][A-Z0-9_]+)=', text('.env.example'), re.M))
operation_names = set(re.findall(r'\bSENTINEL_[A-Z0-9_]+\b', text('docs/OPERATIONS_AND_COST_PLAN.md')))
for name in sorted(operation_names - environment_names):
    errors.append('Operations advertises an unimplemented environment variable: ' + name)
check('Existing claim/feedback capability and single schedule authority agree', errors,
      dict(scope='Document conflicts/configuration names only; current route count is separately compared with source'))

errors = []
project_map = json.loads((ROOT / 'pkg.json').read_text(encoding='utf-8-sig'))
document_paths = {node.get('path') for node in project_map['nodes']
                  if node.get('path', '').startswith('docs/')}
if document_paths != {name for name in EXPECTED if name.startswith('docs/')}:
    errors.append('Project map contains missing or obsolete planning-document nodes')
for node in project_map['nodes']:
    path = node.get('path', '')
    if path and (path.endswith(('.md', '.pdf', '.docx', '.csv', '.html')) or
                 path.startswith(('docs/', 'output/'))) and not (ROOT / path).exists():
        errors.append('Project map points to absent document/bundle: ' + path)
node_ids = {node['id'] for node in project_map['nodes']}
if any(edge['from'] not in node_ids or edge['to'] not in node_ids for edge in project_map['edges']):
    errors.append('Project map contains dangling edges')
check('Project map retains only existing final document owners', errors,
      dict(scope='Documentation catalog only; inherited runtime graph remains provisional'))

errors = []
arch = text('docs/ARCHITECTURE.md')
api = text('docs/DATA_AND_API_CONTRACTS.md')
implemented_tables = set()
for migration in (ROOT / 'supabase/migrations').glob('*_sentinel_*.sql'):
    implemented_tables.update(re.findall(r'create table public\.(\w+)',
                                        migration.read_text(encoding='utf-8-sig'), re.I))
for table in sorted(implemented_tables):
    if table not in arch:
        errors.append('Architecture omits implemented table: ' + table)
if 'sentinel_budget_reservations' in arch:
    errors.append('Architecture retains superseded execution-table name')
for clause in ['Implemented run error contract', 'RUN_CONFLICT/RUN_BUSY to 409',
               'traceId and retryable fields are not currently emitted',
               'command identity distinct from admission', 'all other rows specify future endpoints']:
    if clause not in api:
        errors.append('Run API contract omits current/proposed boundary: ' + clause)
actual_routes = set()
for route in (ROOT / 'src/app/api/sentinel').rglob('route.ts'):
    url = '/' + route.relative_to(ROOT / 'src/app').as_posix().removesuffix('/route.ts')
    url = re.sub(r'\[([^\]]+)\]', r':\1', url)
    for method in re.findall(r'export async function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\(', route.read_text(encoding='utf-8-sig')):
        actual_routes.add((method, url))
declared_routes = set()
for line in api.splitlines():
    if line.startswith('| ') and 'Implemented local' in line:
        match = re.match(r'\| (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (/api/sentinel/[^ |]+) \|', line)
        if not match:
            errors.append('Unparseable implemented endpoint declaration: ' + line)
        else:
            declared_routes.add(match.groups())
    elif re.match(r'^\| (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /api/sentinel/', line):
        if 'Planned endpoint' not in line:
            errors.append('Future endpoint lacks explicit planned label: ' + line)
if actual_routes != declared_routes:
    errors.append('Implemented API/source declarations disagree: ' + repr(actual_routes ^ declared_routes))
for name, content in [('docs/ARCHITECTURE.md', arch), ('docs/DATA_AND_API_CONTRACTS.md', api)]:
    for count in re.findall(r'\b(\d+) (?:HTTP )?methods (?:present|exist) in (?:local )?source', content):
        if int(count) != len(actual_routes):
            errors.append(name + ': hard-coded method count differs from route exports')
    for count in re.findall(r'\bcontain (\d+) tables\b', content):
        if int(count) != len(implemented_tables):
            errors.append(name + ': hard-coded table count differs from migrations')
check('Implemented table mappings and run API contract match the current partial foundation', errors,
      dict(implemented_tables=len(implemented_tables), implemented_routes=len(actual_routes), scope='Document/source comparison, not runtime acceptance'))

errors = []
scope = text('docs/PRODUCT_REQUIREMENTS.md')
for phrase in ['Deterministic complete search', 'Missing values remain incomplete',
               'Assign every selected task exactly once', 'no partial assignment']:
    if phrase not in scope:
        errors.append('Supported scheduling contract omits: ' + phrase)
if 'first-fit' in scope.lower() or 'Missing values make affected tasks infeasible' in scope:
    errors.append('Supported scheduling contract conflicts with complete allocation/unknown semantics')
if 'complete subset search' not in arch or 'incomplete/infeasible output retains selected IDs' not in arch:
    errors.append('Architecture conflicts with complete selected-task allocation')
check('One complete allocation contract and explicit missing-estimate semantics', errors,
      dict(scope='Specification consistency only; no scheduling/runtime test executed'))

errors = []
progress = text('docs/DECISIONS_AND_BUILD_GATE.md')
proposal_paths = ['src/lib/sentinel/plans.ts', 'src/lib/sentinel/plan-http.ts',
                  'supabase/migrations/20261012001000_sentinel_plan_drafts.sql']
for path in proposal_paths:
    if not (ROOT / path).is_file():
        errors.append('Documented proposal source missing: ' + path)
for phrase in ['Current checkout: LOCAL_PROVIDER_', '14 failed / 40 passed',
               'historical passes', 'SEN-plan-allocation-order', 'unchanged original oracle']:
    if phrase not in progress:
        errors.append('Current proposal evidence boundary omits: ' + phrase)
for phrase in ['local focused qualification passed', 'nullable captured policyRevisionId', 'approvalReady=false']:
    if phrase not in api:
        errors.append('Proposal contract omits qualification/approval boundary: ' + phrase)
if 'Production build of current checkout and local seal | PASS' in progress:
    errors.append('Earlier passing build falsely describes newer proposal checkout')
check('Current proposal failures cannot become current broad or approval acceptance', errors,
      dict(scope='Dated source/status reconciliation; original failure receipts remain outside the pack'))

# This validates this handoff's restricted scalar/list schema; it is not a general YAML parser.
errors = []
blocks = re.findall(r'```yaml\n(.*?)```', text('docs/PRODUCT_STRATEGY.md'), re.S)
families = {'Proprietary data & learning loop', 'Network effects',
            'Switching costs & workflow lock-in', 'Trust, governance & auditability',
            'Domain depth & codified expertise', 'Distribution & point-of-work embedding',
            'Scale economics / cost or performance edge', 'Regulatory or structural edge'}
if len(blocks) != 1:
    errors.append('Expected one final typed handoff')
else:
    block = blocks[0]
    root_keys = re.findall(r'^(\w+):', block, re.M)
    if root_keys != ['idea_slug', 'source_run', 'stop_reason', 'verdict_tier',
                     'for_product_vision', 'for_product_backlog']:
        errors.append('Handoff root keys differ')
    vision_keys = re.findall(r'^  (\w+):', block.split('for_product_backlog:')[0], re.M)
    if vision_keys != ['problem_statement', 'thesis_candidate', 'target_buyer', 'target_user',
                       'why_now', 'willingness_to_pay', 'durability_claims']:
        errors.append('Vision keys differ')
    if not re.search(r'^source_run: PRODUCT_STRATEGY.md$', block, re.M):
        errors.append('Handoff source run not final strategy file')
    if not re.search(r'^stop_reason: capped$', block, re.M):
        errors.append('Moat stop condition changed without evidence')
    for key in ['why_now', 'willingness_to_pay']:
        if f'  {key}: "[founder input needed]"' not in block:
            errors.append('Unvalidated founder input fabricated: ' + key)
    claims = re.findall(r'^    - moat_family: (.+)\n      claim: (.+)\n      stage: (.+)$', block, re.M)
    seeds = re.findall(r'^    - title: (.+)\n      acceptance_criteria: (.+)\n      effort: (.+)\n      seeds_moat_family: (.+)$', block, re.M)
    if len(claims) != 3 or len(seeds) != 3 or len({c[0] for c in claims}) != 3:
        errors.append('Expected three conditional seed families with complete seed records')
    if any(c[0] not in families or c[2] != 'seed_v1' for c in claims):
        errors.append('Invalid durability family/stage')
    if any(s[2] not in {'S', 'M', 'L'} or s[3] not in families for s in seeds):
        errors.append('Invalid seed family/effort')
    if {c[0] for c in claims} != {s[3] for s in seeds}:
        errors.append('Seed family/claim mismatch')
check('One final typed strategy handoff with three conditional seeds', errors,
      dict(added_feature_groups=5, established_moats=0, grader='Earlier independent blind design assessment'))

errors = []
if {int(r['rules_section']) for r in compliance} != set(range(1, 16)):
    errors.append('Not every official-rules section mapped')
for row in compliance:
    if not row['owner'] or not row['required_evidence'] or not row['status'].startswith('PENDING_'):
        errors.append(row['compliance_id'] + ': no owner/evidence or false fulfillment')
    if row['source_url'] != 'https://nebiusglobalaihackathon.devpost.com/rules':
        errors.append(row['compliance_id'] + ': nonofficial rule authority')
submission = text('docs/SUBMISSION_PLAN.md')
for phrase in ['overall OR track', 'one bonus', '11.4', 'attendance', '10:00 a.m. Pacific',
               'noon Pacific', 'under three minutes', 'LICENSE', 'without a private learning corpus',
               'private', 'Public', 'Submission freeze']:
    if phrase.lower() not in submission.lower():
        errors.append('Missing submission control: ' + phrase)
check('All numbered rules retained with explicit pending fulfillment', errors,
      dict(sections=15, obligations=26, registration_submission_terms='NOT_PERFORMED'))

errors = []
arch = text('docs/ARCHITECTURE.md')
api = text('docs/DATA_AND_API_CONTRACTS.md')
tool = text('docs/SOURCE_AND_TOOL_CONTRACTS.md')
scope = text('docs/PRODUCT_REQUIREMENTS.md')
required_clauses = {
    'durable and approval protocols': (arch, ['shared current-membership row lock first',
        'unresolved human outcome', 'database wall clock', 'every selected task assigned',
        'never waits for a human', 'one deadline', 'worst-case reservation', 'late worker',
        '120 seconds', '24,000 input', '6,000 reserved output', 'four:', 'At most eight']),
    'feedback and role contract': (api, ['incident_commander accept/reject',
        'analyst modify/annotate', 'exactly one claim_review_id or review_decision_id',
        'Absent, revoked or mismatched permission', '2 KiB UTF-8', 'distinct immutable artifact/hash']),
    'provider boundary': (tool, ['cannot claim to enforce or attest its hidden DNS/redirect hops',
        'All incident approvals blocked', 'HTTP 200', 'results and failed_results']),
    'scope completeness': (scope, ['All 25 requirements', "FireAfter's 25 capabilities",
        'five registered', 'ten inspection', 'two crews', 'eight hours'])}
for label, (content, phrases) in required_clauses.items():
    for phrase in phrases:
        if phrase.lower() not in content.lower():
            errors.append(label + ': missing ' + phrase)
check('Concrete conflict resolutions retained in their final owner specifications', errors,
      dict(scope='Clause presence and consistency only; not runtime enforcement'))

errors = []
hours = [sum(int(t[key]) for t in tasks if t['task_id'] != 'SEN-T24')
         for key in ['estimate_hours_low', 'estimate_hours_high']]
contingency = [math.ceil(h * 1.2) for h in hours]
if hours != [128, 207] or contingency != [154, 249]:
    errors.append('Effort arithmetic differs from build plan')
plan = text('BUILD_PLAN.md')
if 'Re-estimate' not in plan and 're-estimate' not in plan:
    errors.append('Missing scope-change effort checkpoint')
if 'sole owner' not in plan or 'depends_on' not in plan:
    errors.append('Second date/dependency authority introduced')
check('Provisional effort and single schedule ownership', errors,
      dict(submission_hours=hours, upward_rounded_contingency=contingency,
           ongoing_judging_operations='ADDITIONAL_UNESTIMATED'))

baseline = json.loads(text('docs/evidence/source-baseline.json'))
errors = []
imported = baseline.get('sentinel_import', {})
import_files = imported.get('files', [])
if imported.get('status') != 'SOURCE_IMPORTED_UNVERIFIED' or imported.get('file_count') != 444:
    errors.append('Missing/incorrect local source import status')
if len(import_files) != 444 or len({i['path'] for i in import_files}) != 444:
    errors.append('Import manifest has missing or duplicate copied paths')
for item in import_files:
    relative = Path(item['path'])
    if relative.is_absolute() or '..' in relative.parts or not re.fullmatch(r'[0-9a-f]{64}', item.get('sha256', '')):
        errors.append('Invalid import manifest path/hash')
    if not isinstance(item.get('bytes'), int) or item['bytes'] < 0:
        errors.append('Invalid import byte length')
if Path(imported.get('destination_root', '')).resolve() != ROOT:
    errors.append('Import destination is not this independent project')
for name in ['README.md', 'BUILD_PLAN.md', 'PROVENANCE.md', 'docs/PROJECT_ISOLATION.md',
             'docs/ARCHITECTURE.md', 'docs/DECISIONS_AND_BUILD_GATE.md']:
    content = text(name).lower()
    if any(phrase in content for phrase in ['specifications only', 'documentation-only workspace',
                                           'no app has been imported', 'no fireafter application files have been imported',
                                           'no sentinel source import']):
        errors.append(name + ': stale pre-import status')
check('Consistent imported-but-unaccepted status and complete copy provenance', errors,
      dict(copied_files=len(import_files), task='SEN-T01 IN_PROGRESS',
           scope='Import history integrity; not current runtime acceptance'))

protected = Path(baseline['source']['local_path']).resolve()
expected_protected = Path(r'C:\Users\vijay\OneDrive\Documents\FireAfter').resolve()
errors = []
if protected != expected_protected or protected == ROOT:
    errors.append('Protected source path does not match declared FireAfter boundary')
else:
    def git(*args):
        result = subprocess.run(['git', '-c', f'safe.directory={protected.as_posix()}',
                                 '-C', str(protected), *args], capture_output=True, check=True)
        return result.stdout
    source_paths = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').decode().split('\0')
    source_files = {p: sha(protected / p) for p in source_paths if p and (protected / p).is_file()}
    digest = hashlib.sha256(json.dumps(source_files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    if digest != baseline['working_tree_fingerprint']['sha256']:
        errors.append('Full protected working-tree fingerprint changed')
    if len(source_files) != baseline['working_tree_fingerprint']['file_count']:
        errors.append('Protected source file count changed')
    current = {'head': git('rev-parse', 'HEAD').decode().strip(),
               'remote_url': git('remote', 'get-url', 'origin').decode().strip(),
               'dirty_status': git('status', '--porcelain=v1').decode().splitlines()}
    for key, value in current.items():
        if baseline['source'][key] != value:
            errors.append('Protected source ' + key + ' changed')
    for item in baseline['source']['selected_files']:
        if source_files.get(item['path']) != item['sha256']:
            errors.append('Selected source changed: ' + item['path'])
check('Original FireAfter remains unchanged', errors,
      dict(files=baseline['working_tree_fingerprint']['file_count'],
           selected_fingerprints=len(baseline['source']['selected_files']),
           boundary='Local tracked/non-ignored-untracked fingerprints only; no production call'))

failed = any(c['outcome'] == 'FAIL' for c in CHECKS)
manifest_path = ROOT / 'docs/PLANNING_MANIFEST.json'
entries = [dict(path=n, sha256=sha(ROOT / n), bytes=(ROOT / n).stat().st_size)
           for n in sorted(EXPECTED - GENERATED) if (ROOT / n).is_file()]
manifest = dict(schema_version=1, edition='FINAL_PLANNING',
                created_at_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                status='FINAL_SPECIFICATIONS_LOCAL_BASELINE_ACCEPTANCE_PENDING', counts=counts,
                artifact_counts=dict(markdown=18, csv=7, json=3, validator=1, total=29),
                hash_scope='All 27 final planning source artifacts; runtime, instructions, manifest and current validation excluded',
                files=entries)
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
hash_errors = [e['path'] for e in entries if sha(ROOT / e['path']) != e['sha256']]
check('Current final manifest hashes', hash_errors, dict(hashed_files=len(entries)))
failed = failed or bool(hash_errors)
result = dict(schema_version=1, edition='FINAL_PLANNING',
              validated_at_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
              scope='Executed document, structured-reference and source-preservation checks only',
              outcome='FAIL' if failed else 'PASS', validation_exit_code=1 if failed else 0,
              counts=counts, checks=CHECKS, app_runtime='LOCAL_BASELINE_CHECKS_STARTED_ACCEPTANCE_PENDING',
              runtime_red_team='NOT_RUN_NO_SENTINEL_TARGET', formal_loop='NOT_ADMITTED',
              release='NOT_EVALUATED', hackathon_fulfillment='PENDING_HUMAN_AND_RUNTIME_EVIDENCE')
(EVIDENCE / 'document-validation.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(dict(outcome=result['outcome'], checks=len(CHECKS), final_artifacts=29,
                     failures=[c for c in CHECKS if c['outcome'] == 'FAIL']), indent=2))
sys.exit(result['validation_exit_code'])
