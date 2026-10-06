# How to use this pack with Claude Code

1. Create an empty GitHub repo, e.g. `umsha-ledger`, and copy this whole folder into it (`CLAUDE.md` must sit at the repo root).
2. Open the repo in Claude Code.
3. Paste the prompt below for the first session.
4. For each later session, paste the milestone prompt from `docs/07-build-plan.md`.
5. Keep `docs/09-open-decisions.md` updated as you settle questions with the accountant; tell Claude Code "decision D-0x is now X, update the docs and code".

---

## First-session prompt (paste this)

```
You are starting the UMSHA Ledger project. Read CLAUDE.md, then every file in docs/ in numbered order, then the CSVs in seed/.

Before writing any code:
1. Summarise back to me in under 200 words: what the system is, the stack, the 10 invariants, and the build order.
2. List anything in the docs that is contradictory or underspecified, with your proposed resolution. Add any new items to docs/09-open-decisions.md.
3. Then execute Milestone M0 from docs/07-build-plan.md. Stop when M0's "Done when" criteria pass and show me the test output.

Rules for this whole project:
- All accounting logic in /core as pure functions with node tests. Apps Script does I/O only.
- Money in integer paisa. Never floats.
- Never edit posted journal rows. Corrections are reversals.
- Every journal line has a brand: UMSHA, MIRAE or SHARED.
- Tax rates come from TaxCodes, never hard-coded.
- Do not add frameworks, paid services or Netlify.
- One milestone per session. Run `npm test` before saying you are done.
```

## Useful follow-up prompts

- *"Run all tests, then walk scenario T06 through the code and show me the exact journal produced."*
- *"Review /core for any path that could break an invariant in CLAUDE.md. List findings before fixing."*
- *"Generate 20k lines of realistic synthetic data for 12 months (MTO and RTW) into a test Sheet and time every report."*
- *"Write docs/USER-GUIDE.md for store staff: one page, plain English, screenshots placeholders."*
