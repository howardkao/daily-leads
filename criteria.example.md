# Fit Criteria

`classify-new-leads.mjs` reads this file and uses it as the auto-filter's
judgment criteria. Postings matching it get filtered out of your review
queue before you ever see them -- with the model's own reasoning saved to
`data/lead-decisions.tsv` so every auto-filtered decision stays auditable
and reversible.

Copy this file to `criteria.md` (gitignored) and replace the example below
with your own. Be specific, and give the model something to weigh nuance
against rather than a keyword list -- LLM classification earns its keep
here specifically because it can tell "the JD mentions this once in
passing" apart from "this is genuinely what the role is."

## Example (replace with your own)

You want human-facing/consumer product work (0-1 discovery, mission-driven,
owning the end-user experience) -- NOT backend/platform/integrations-focused
technical PM work (APIs, developer tools, internal infrastructure, technical
stakeholders as the primary "user").

Many JDs mention words like "API," "platform," or "integrations" without
that being what the role actually is -- e.g. "partners with the platform
team," "some API familiarity a plus," a passing mention in a long bullet
list. That is NOT a mismatch. Judge the role's actual center of gravity:
what does it spend most of its time on, and who is it primarily built for?
Only flag a mismatch when the role's core, majority scope really is the
thing you're trying to avoid -- not because a keyword appears somewhere in
the text.
