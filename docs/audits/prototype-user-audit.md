# Sourcer prototype: user experience audit

Reviewed 25 September 2026 against prototype commit a8d1dcb. Scope: the private desktop prototype, not the existing local Sourcer engine. Local index.html and deployed-bundle dist/index.html were byte-identical. Browser tests ran against the local bundle; authenticated production behavior was not independently exercised. This is an expert walkthrough and heuristic audit, not participant research or a measured SUS score.

## Verdict

The visual direction is coherent, but the prototype does not yet support a complete recruiter journey. It starts halfway through a fictional campaign. Critical controls report outcomes they do not perform. It is suitable for discussing appearance, not validating whether a recruiter can do the job independently.

The prior report that interactions passed was too broad: the earlier script checked navigation, counter increments and modal visibility, not task completion, persistence or recovery.

## Intended journey and current outcome

| Recruiter's goal | Current outcome |
|---|---|
| Understand first launch and start a role | Blocked: no onboarding, empty workspace or New search |
| Load their own brief | Blocked: no file picker, paste-and-read flow or replacement mechanism |
| Correct extracted requirements | Partial: editable summary; extracted fields and chips are static |
| Review and save tailored searches | Partial: Boolean text editable; no real copy, validation or save |
| Connect LinkedIn | Simulated label change presented as successful connection |
| Start, monitor or stop search | Blocked: no run controls or progress/error flow |
| Inspect and approve candidates | Partial: cards navigate and disappear; approval does not populate queue |
| Prepare and complete outreach | Blocked: opening is a toast, completion missing, draft edits lost |
| Handle a reply or blocked identity | Blocked: no reply inbox or name-resolution input |
| Return tomorrow and resume | Blocked: reload resets decisions and edits |

## Findings

P1 = blocks core use or undermines trust. P2 = major friction, accessibility or recoverability. P3 = polish. These priorities describe usability of the prototype; missing live integrations can remain simulated if clearly labeled and internally consistent.

| ID | Priority | Finding and evidence | User consequence | Acceptance criterion |
|---|---|---|---|---|
| U01 | P1 | No New search, campaign list or role switcher | Cannot begin a real recruiting task | Persistent New search entry; named drafts and saved searches can be reopened |
| U02 | P1 | Filename and brief are sample text; View original only shows a toast | A recruiter mistakes a sample PDF for their uploaded document | Label sample data; implement paste/upload state, source preview, replace and extraction errors |
| U03 | P1 | Login immediately claims connected; no window opens or session is verified | False confidence about which account is active | Prototype explicitly says simulated; real app confirms identity and session health before claiming connection; cancellation/expiry recoverable |
| U04 | P1 | Save role, Copy Boolean, View original, history and experiment controls only show notifications | Users believe work is saved or copied when it is not | Perform local prototype operations or visibly disable them; never report an unperformed outcome |
| U05 | P1 | No run/rerun, pause, stop, progress, zero-result or partial-failure states | Cannot execute or control searches | Search plan has run entry; explicit pending/running/stopped/complete/error states and retry |
| U06 | P1 | Approving Amina increases queue badge from 4 to 5 but leaves four static action cards; Amina absent | Approved person disappears from review without an actionable next step | Approval creates exactly one queue item for that person; all counts derive from shared state |
| U07 | P1 | Six cards shown against 12 claimed; after processing six, cards reach zero, badge remains 6, detail rendering throws undefined face error | Reviewing all candidates breaks the screen | Correct totals and completion state with next steps; no stale detail or runtime error |
| U08 | P1 | Open LinkedIn only closes modal and toasts; no actual opening or completion control | Outreach cannot be completed or tracked | Explicit demo transition or real profile link; completed/deferred/failed outcomes and duplicate prevention |
| U09 | P1 | Changing draft then Keep for later and reopening restores default copy | Recruiter loses carefully written outreach | Draft retained per person; save state and discard behavior explicit |
| U10 | P1 | Reload restores all sample candidates; edits/decisions are not persisted | Work is lost between visits | Persist prototype state locally with clear reset; validate retention after reload |
| U11 | P1 | Prototype requires manual completion of every action; existing engine's promised workflow executes approved outreach | Product behavior differs from the agreed purpose | Define approval boundary and accurately model execution, acceptance, follow-up, reply freeze and human handoff |
| U12 | P2 | Extracted title/location/seniority and ranking chips are not editable controls; Edit terms only toasts | Cannot correct interpretation or refine intent | Labeled fields with edit/cancel/save; demonstrate propagation to search plan |
| U13 | P2 | Spec checked and 8 requirements found remain static after editing; searches don't regenerate | Invalid or changed briefs appear validated | Dirty state, actual prototype validation and explicit regenerate step; preserve manual query edits |
| U14 | P2 | Search rationale promises AWS protection but uses AWS OR cloud security; skill-led plan says IAM is key but permits other terms without IAM | Search explanation does not reliably describe constraints | Explain AND/OR groups accurately; distinguish must-have gates from ranking preferences and enforce selected gates |
| U15 | P2 | Evidence consists of summaries without source links, dates or underlying excerpts | Recruiter cannot verify fit before contact | Evidence links, observed date and uncertainty for every important claim |
| U16 | P2 | Pass removes person immediately with no undo or reason; Insights says undo available without a control | Accidental decisions and learning cannot be corrected | Undo/revisit decisions; explicit rejection reason and reversible learned rule |
| U17 | P2 | Resolve opens blocked missing-name modal with no way to correct name; displayed full name already exists | Dead end and confusing identity status | Explain uncertainty and provide editable verified name, profile evidence, retry or skip |
| U18 | P2 | Best match/Newest have no handlers; list puts score 79 before 82; global search and Cmd-K indicator do nothing | Navigation and prioritization cannot be trusted | Functional sorting/filtering and shortcut, or remove unsupported controls |
| U19 | P2 | Settings and notifications have no meaningful controls; daily limits are asserted without visible values | Cannot configure schedule, account controls or investigate alerts | Working essential settings: account, hours/timezone, caps, off-limits clients and stop controls |
| U20 | P2 | Replies only a metric; no thread list, stopped state or resume workflow | Cannot perform the most valuable handoff: answer interested people | Replies surface actionable people and thread context; outreach stays paused until explicitly resumed |
| U21 | P2 | Modal opens with focus left on background Review button; no focus trap or return handling; closed overlay uses opacity/pointer-events only | Keyboard users can interact outside modal and reach hidden controls | Focus enters dialog, remains inside, returns on close; hidden dialog removed from focus/accessibility tree |
| U22 | P2 | At 390px login disappears; nav labels hidden without aria-labels; Role button has empty visible text | Narrow-screen and assistive access lose essential navigation | Preserve account access and meaningful accessible names at all supported widths |
| U23 | P2 | Many important labels/body details use 7–11px type; tiny action targets; no reduced-motion treatment or live-region toast | Readability and feedback are poor for users needing zoom or assistive technology | Increase working text size, verify 200% zoom and contrast, expose status announcements and reduced-motion behavior |
| U24 | P2 | Private on this Mac, verified evidence, precision and time-saved claims shown in hosted sample environment without clear demo boundary | Users confuse illustrative values and privacy promises with observed behavior | Persistent sample-data notice; accurate storage explanation and defined metrics; separate example results from live state |
| U25 | P2 | Screen selection is not reflected in URL; no role identity across routes | Cannot bookmark/share a screen or use browser Back reliably | Stable routes or hashes and selected-search context restored on navigation |
| U26 | P3 | New Role layout stretches shell backgrounds beneath content; language includes unexplained recovery, signals and model | Adds visual noise and learning effort | Align card height to content; use recruiter language with optional explanations |

## What should be retained

The role brief beside two complementary searches is a useful foundation. Candidate list plus detail reduces navigation. Visible match reasons and a dedicated review queue support recruiter judgment. The restrained visual palette and consistent cards can remain while the workflow is rebuilt.

## Repair sequence

1. Establish honest, shared prototype state: explicit demo mode, one source for candidates/queue/counts, persistence, draft retention and empty-state recovery.
2. Complete the entry journey: New search → paste/upload brief → review extracted details → review/edit two tailored searches → save draft/run simulation.
3. Complete the core loop: results → verifiable candidate evidence → approve/pass with undo → queue → review draft → execution outcome → reply handoff.
4. Add essential controls: LinkedIn session states, search progress/stop/retry, schedule/caps/client exclusions and blocked-identity recovery.
5. Fix keyboard focus, names, status announcements, working text size, responsive access and browser navigation.
6. Validate with recruiters before backend integration expands. Avoid adding CRM, email sequences or broad analytics to compensate for an incomplete core loop.

## Release gate for the next prototype

A first-time recruiter must be able to create a search from their own brief, correct a mistake, inspect both queries, run a clearly simulated search, verify evidence, approve and reject people, undo a mistake, preserve an edited draft, complete an action, resolve a blocked identity, see a reply halt outreach, and refresh without losing progress. All sample counts must reconcile. Reviewing the last candidate must end cleanly. Keyboard-only navigation must complete the same path.

## Verification record

Browser walkthrough at 1440 × 1000 plus narrow viewport 390 × 844 reproduced: 6/12 mismatch; approved Amina missing from queue despite badge increment; draft loss after Keep for later; no new page after Open LinkedIn; final-candidate TypeError; reset after reload; hidden mobile login; focus left outside the open dialog. Source inspection confirmed inert controls, static validation, no persistence, no file upload and missing execution/reply workflows. Full automated accessibility conformance, real LinkedIn authentication, candidate quality and production security were outside this UX audit.
