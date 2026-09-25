## Deep Review: Sourcer runtime and desktop prototype

### Executive Summary
- **Scope**: prototype HTML/role-registration JavaScript plus runtime orchestration, actions, and persistence dependencies. Prototype changes are NEW relative to main; runtime findings are PRE-EXISTING on this branch.
- **Agents Run**: code reviewer/accessibility scanner; silent-failure hunter/Node backend reviewer; dependency mapper/cycle detector/hotspot analyzer/pattern scout/scale assessor. Lenses were grouped into three parallel review tasks using available Codex agents.
- **Agents Missing**: None of the three dispatched tasks. This is not a claim that every optional deep-review aspect was run.
- **Priorities**: No P0 established. Five NEW P1 finding groups; seven PRE-EXISTING P1 findings. Prototype defects should be assessed as simulation/workflow failures, not production security emergencies.
- **Validation**: source inspection; parent browser verification of active-role mismatch and cross-tab role overwrite; prior browser audit verified review-exhaustion crash. Isolated Store accounting reproduction returned zero profile views after a successful-message accounting sequence. All 262 tests passed in an isolated source snapshot using existing dependencies and localhost permission; no live LinkedIn actions were performed.

---

## NEW ISSUES (Introduced by this branch)

### Important Issues (P1 — should fix)

#### N1. Candidate review cannot complete a coherent approval-to-action workflow
- **Source**: code-reviewer.
- **Location**: `design/sourcer-desktop-prototype/index.html:185–187`; static queue at `139–143`; initial totals at `182`.
- **Failure**: approving Amina increments the action count but never creates her action card. Maya and Theo already have static actions before approval and remain there if passed. After processing all six candidates, selected becomes -1 and renderDetail dereferences undefined; stale actionable details remain and the count still says six left.
- **Fix**: derive counts, review rows and actions from shared collections; create actions on approval and render a completed state when review is empty. Cover the entire six-candidate journey, not just the first click.

#### N2. Selecting a registered role does not change the workspace
- **Source**: code-reviewer, pattern-scout, dependency-mapper.
- **Location**: `design/sourcer-desktop-prototype/roles.js:13`; `index.html:121,124,148–157,190`.
- **Failure**: register/select a Rust role in London, then click Role or Review. The brief, breadcrumb, candidates and outreach still describe Cloud Security in New York. Registration only updates its own panel. Parent browser verification confirmed this.
- **Fix**: one active role ID must drive every screen; use empty/sample states for newly registered roles until a simulated search produces results. The explicit absence of live sourcing is expected prototype scope, not itself a defect.

#### N3. Save/keep/copy feedback is inconsistent with durable behavior
- **Source**: code-reviewer.
- **Location**: `design/sourcer-desktop-prototype/index.html:148,155–156,182,187,190–192`.
- **Failure**: Keep for later discards edited drafts when reopened; refresh restores all review decisions. The original Role screen's Save role and Copy Boolean buttons only display success toasts, without saving or copying. The registration screen really does save, making the conflicting behavior particularly misleading.
- **Fix**: persist role-scoped drafts and decisions, route both role editors through the same storage, and implement clipboard writes with failure feedback. Clearly disable unavailable demonstration actions instead of reporting success.

#### N4. Keyboard and screen-reader access breaks in dialogs and compact navigation
- **Source**: accessibility-scanner, code-reviewer.
- **Location**: `design/sourcer-desktop-prototype/index.html:69,71–72,83–90,170,190–195`.
- **Failure**: the closed modal is hidden only by opacity/pointer-events, leaving invisible controls in tab order and the modal in the accessibility tree. Opening it neither moves/traps focus nor makes background inert. At <=980px navigation labels are display:none, leaving SVG-only buttons without accessible names; at <=680px Insights and the login header disappear.
- **Fix**: native dialog lifecycle with sensible initial/restored focus; accessible names independent of visible labels; a compact navigation/menu retaining functionality. Relevant WCAG criteria: 2.4.3 and 4.1.2.

#### N5. Role creation in another tab overwrites previously saved roles
- **Source**: code-reviewer; parent browser verification.
- **Location**: `design/sourcer-desktop-prototype/roles.js:3,12`.
- **Failure**: two tabs load the same role snapshot; tab A saves role A, then tab B saves role B from stale memory. B replaces the entire list, losing A on refresh.
- **Fix**: reconcile against current storage before mutation and subscribe to storage changes; transactional storage if concurrent editing is supported. P1 because this reproducibly deletes user-created roles.

---

## PRE-EXISTING ISSUES (In scope)

These runtime defects are inherited from main, not introduced by the prototype. They should be fixed before treating this branch as a safe live-runtime release.

### Important Issues (P1 — should fix)

#### R1. Successful follow-ups discard profile-view accounting
- **Source**: silent-failure-hunter, ts-backend-reviewer.
- **Location**: `src/actions/followup.js:181–183,247–251`; `src/store.js:203–205`.
- **Failure**: the thread-open profile view and lastCheckedAt are recorded in memory, then store.refresh reloads disk before save. Successful messages therefore do not count their profile views, allowing subsequent work beyond the configured profile-view cap. Isolated Store reproduction confirmed the discarded view.
- **Fix**: persist the view before send or restore it after refresh; test successful sends with profileViews=1 and multiple due leads.

#### R2. A global acceptance throttle starves later roles
- **Source**: silent-failure-hunter, ts-backend-reviewer.
- **Location**: `src/actions/followup.js:34–41,52`; `src/run.js:113–116,139–140`.
- **Failure**: the first role consumes the global acceptance-scan interval, but results are applied only to that role. With pending invitations on that role, later roles repeatedly return early; accepted candidates may remain invited indefinitely and receive no first message.
- **Fix**: scan connections once and apply/cache results across every applicable role. Add a two-role regression.

#### R3. Automated InMail targets fresh leads instead of overdue invitations
- **Source**: silent-failure-hunter, ts-backend-reviewer.
- **Location**: `src/actions/inmail.js:110–123`; compare `src/app.js:59–62`.
- **Failure**: the automated lane selects approved status=new candidates, ignoring elapsed invitation age. It can spend credit immediately on fresh candidates while excluding invited candidates the UI marks as due.
- **Fix**: share one first-InMail-due predicate between planner and runner. Reviewer identified an existing correction on codex/fix-audit-issues; integrate and verify that fix rather than reimplementing blindly.

#### R4. Cross-process request updates can drop or replay searches
- **Source**: silent-failure-hunter, pattern-scout, scale-assessor.
- **Location**: `src/requests.js:9–22,32–35`; producers/consumers at `src/app.js:360–362`, `src/run.js:42–45,114`.
- **Failure**: independent app/runner read-modify-write transactions overwrite each other, losing a new request or restoring a consumed one. Direct writes can expose truncated JSON; catch-all read fallback silently turns that into an empty queue. The user sees queued success but work may never run.
- **Fix**: lock complete transactions and atomically replace the file; distinguish absent files from corruption. An existing correction reportedly exists on codex/fix-audit-issues; verify/integrate it and add multi-process tests.

#### R5. Cancelling a queued message while its thread opens does not stop sending
- **Source**: silent-failure-hunter, ts-backend-reviewer.
- **Location**: `src/actions/followup.js:148–151,170–181,234–236`.
- **Failure**: dueMessage is captured before awaited navigation. The lead is refreshed afterward, but the queued message and current eligibility are not recalculated. Deleting the queued message or skipping the lead during navigation still allows the captured message to be sent.
- **Fix**: immediately before send, revalidate current status, queue identity/content and stop state; abort cleanly if cancelled. Test cancellation from a separate Store while mocked openThread is pending.

#### R6. Deleting a secondary active role can lose a sent invitation's history
- **Source**: hotspot-analyzer, pattern-scout, scale-assessor.
- **Location**: `src/app.js:373–380`; `src/run.js:104–130`; `src/actions/connect.js:133–158`.
- **Failure**: deletion protects only the role that launched Jobs, while the runner operates on multiple roles. Deleting another currently active role can remove a lead during its pending send. After an external invitation succeeds, setStatus throws on the missing lead and connect accounting is never recorded. A background search can also recreate leads under a deleted role.
- **Fix**: track/protect all active role scopes or coordinate cancellation before deletion; preserve send outcomes independently. Test deleting role B while a run launched from role A is awaiting an injected send.

#### R7. Role edits race with background location enrichment
- **Source**: dependency-mapper, pattern-scout.
- **Location**: `src/config.js:55–60`; `src/actions/search.js:35–36`; `src/app.js:171–189,504–510`.
- **Failure**: both processes replace full campaign objects without a shared transaction. Background enrichment can overwrite a freshly edited specification/exclusions, or an app edit can discard new geography. Direct file writes also expose partial JSON to readers.
- **Fix**: one repository operation that locks, merges intended keys, validates in memory and atomically renames. Test interleaved writes and preservation after invalid updates.

---

### Architecture Health

| Check | Status | Notes |
|-------|--------|-------|
| No circular dependencies | Fail | search dynamically imports recruiter, which imports searchLocations from search. Nonfatal today; extract the pure helper when touching this boundary. |
| Clean layer boundaries | Partial | CLI/HTTP → actions → browser/store/domain helpers is generally clear. Prototype active-role state is disconnected; campaign writes are duplicated. |
| No god modules | Partial | app.js combines routing, presentation, campaign management and process lifecycle (707 lines, 23 local dependencies). Split around concrete transaction/scope fixes, not line count alone. |
| Consistent patterns | Fail | db.json uses locks and atomic rename; request/campaign files lack equivalent protections. |
| Scalable structure | Partial | Suitable for a single-recruiter local product; multi-role execution exposes scope and throttling defects. No distributed infrastructure is warranted. |
| Accessibility | Fail | Dialog lifecycle and responsive navigation naming fail keyboard/screen-reader expectations. |
| Localization readiness | Not assessed | No dedicated localization pass. |
| Concurrency safety | Fail | Cross-process request/campaign races, message cancellation race, prototype multi-tab overwrite. |
| Performance efficiency | Not assessed | No dedicated performance benchmark/pass. |
| Platform conventions | Partial | Node child-process isolation is useful; a missing child error handler deserves follow-up. |

### Strengths
- Browser work runs in child processes with bounded logs and process-group shutdown rather than blocking HTTP handling.
- Main Store refuses corrupt data, merges changed fields, locks writers and atomically replaces db.json; reuse this pattern for smaller stores.
- Role parsing, templates, ranking, limits and source shaping have separate domain modules and substantial targeted tests.
- Source adapters use explicit registry/shape/merge boundaries.
- Registration renders persisted user data through textContent/Option, has visible labels/native validation, and reports storage failures.
- Registration explicitly labels browser-local storage and the absence of live sourcing.
- Outreach propagates checkpoint/login errors and checks conversations for duplicate sends.

### Action Plan
1. Fix runtime cancellation, accounting, active-role deletion, InMail eligibility and acceptance scans before live-account use; integrate applicable audit-branch fixes with regression tests.
2. Reuse transactional storage across requests and campaigns.
3. Complete one consistent prototype journey with shared active-role state, durable decisions/drafts, real queue transitions and an empty/completed review state.
4. Repair dialog/navigation accessibility, then test keyboard-only completion and small-screen navigation.
5. Additional lower-priority findings remain in individual reports: missing-name recovery, query customisations overwritten on detail edits, missing child-process error handling and a nonfatal search/recruiter cycle.

### Review artifacts and gaps
Individual reports: `code.md`, `errors.md`, `architecture.md` in `/tmp/deep-review-sourcer/`. No source changes or deployment performed by reviewers. Runtime action imports were initially blocked by a missing Playwright dependency; the parent subsequently ran all 262 tests successfully in an isolated copy using existing dependencies. Passing tests do not cover the workflow/race failures described above. No claims of live-account or full security certification are made.

## Fix follow-up — 25 September 2026

Implemented corrections for N1–N5 and R1–R7 on `codex/sourcer-desktop-prototype`:
- Role-scoped prototype decisions, drafts and action queue; consistent active role; empty review state; per-role browser records to prevent cross-tab creation loss.
- Modal visibility, keyboard focus trapping/restoration, labelled compact navigation, real clipboard/save behavior and explicit simulation labels.
- Persisted profile-view accounting and pre-send cancellation revalidation; acceptance results applied across roles; shared overdue-invitation InMail eligibility.
- Locked, atomic request/campaign writes with validation before replacement; preservation of current geography during edits; active multi-role run deletion guard.
- Child launch errors now settle job state; CSV exports omit GitHub handle annotations; edited searches survive returning to role details.

Validation: 267 Node tests pass in an isolated source copy using the existing Playwright installation. Added cancellation/accounting, concurrent request writer, corrupt request data, invalid campaign update, and prototype browser regressions. Browser tests pass for approval → queue → saved draft → simulated completion, exhausting review, modal focus, selected-role consistency and two-tab registration. Run the browser regression with `node test/prototype.e2e.js` after installing dependencies/browser runtime.

Limitations: no live LinkedIn sends were exercised. The hosted site remains a browser-local prototype, with example candidates and simulated actions; login requires the local app. Same-role simultaneous edits remain last-write-wins. The nonfatal search/recruiter dependency cycle and broader module decomposition are deferred architecture improvements, not resolved defects. The original findings above remain as the historical review record.
