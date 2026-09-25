# Sourcer desktop prototype

An interactive high-fidelity concept for turning Sourcer into a distributable, local-first recruiting copilot.

## Assumptions

- Primary user: an independent recruiter or boutique technical search consultant.
- Primary job: turn a role brief into a defensible shortlist and prepared outreach without losing judgment or control.
- Product stage: concept validation before implementation planning.
- External LinkedIn actions remain human-confirmed. Candidate data and drafts remain local.

## Product structure

1. **Review** — ranked candidates, readable evidence, approve/pass decisions.
2. **Actions** — prepared connection notes and follow-ups, each requiring user review and completion.
3. **Role** — role definition, must-have signals, exclusions, and search funnel.
4. **Insights** — visible, reversible lessons learned from recruiter decisions.

## Prototype coverage

- Happy path: inspect a candidate, approve them, see the action queue increase, review drafted outreach, and open the human-confirmed action.
- Alternative path: pass a candidate and continue reviewing.
- Error state: a candidate with an unconfirmed first name cannot proceed to outreach.
- Supporting flows: switch among Review, Actions, Role, and Insights; edit prepared outreach; dismiss or postpone an action.

## Design principles

- **One consequential decision at a time.** The selected candidate receives most of the visual weight.
- **Evidence before score.** Every ranking explains the signals and source path.
- **Preparation, not hidden automation.** External actions live in a separate queue and require a final human step.
- **Local trust is visible.** Privacy and action ownership remain present in the application frame.
- **Learning is reversible.** Product language describes what was learned and keeps an undo path.

## Visual system

- Warm paper canvas with a deep evergreen navigation rail.
- Acid-lime accent reserved for approvals, progress, and primary actions.
- Georgia supplies editorial emphasis; Avenir Next supplies operational UI text.
- Nested shells, concentric radii, and low-contrast ambient shadows create physical depth.
- Motion uses a weighted spring curve and only animates opacity and transforms.

## Suggested usability test

Recruit 5–6 independent recruiters and ask them to:

1. Find the strongest candidate and explain why the system ranked them highly.
2. Approve that candidate and locate the resulting action.
3. Review and edit the connection note.
4. Explain what Sourcer will and will not do after “Open LinkedIn.”
5. Resolve the candidate whose first name is unconfirmed.

Targets: at least 90% task completion, under 45 seconds from candidate selection to decision, zero participants who believe Sourcer sends automatically, and SUS above 80.
