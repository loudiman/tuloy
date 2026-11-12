# Dashboard screenshots (ticket 7, 11 Nov 2026)

All are real runs of the conductor, made in headless Chrome against `node tests/harness/fake-run-server.ts`
(the scripted model answers; no real model call). The owner name on the page says so.

- `empty-state.png`: no run yet.
- `recovering-run.png`: the presenter injected an invalid output at the script agent (demo mode); the task is stalled and waits for retry 1 of 2.
- `done-run.png`, `done-run-whole-trail.png`: the same run after the retry; one handoff is open in the trail.
- `escalated-run.png`, `narrow-layout.png`: the reviewer rejected a script and the run ended as escalated.

## Follow-up (11 Nov 2026)

Made against `node tests/harness/two-fake-tuloys.ts` (Lou and Sam, both with the scripted model; no real model call).

- `peers-screen.png`: Sam's peers screen in the dashboard's look, after Sam accepted an invite that Lou's peers screen made.
- `run-for-a-peer.png`: Sam's dashboard with the run "for Lou": Lou sent one task for the script agent over A2A.
- `typed-goal.png`: a goal that the owner typed; it has no SAMPLE label. The scripts are the scripted model's fixed answer, so they do not fit the typed goal.
- `invalid-output-plain-sentence.png`: the cause of an invalid output is "The output has no list of scripts."; the raw detail is under "Content".
