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

## The 3D street (12 Nov 2026)

One real run of the sample goal on Lou's Tuloy, with Sam's Tuloy (the sample owner) as its peer. The two used the real model
`anthropic/claude-sonnet-5.5` through OpenRouter. The presenter injected an outage of all own models at the script agent (demo mode);
the rest is real. The run ended as done in 56 seconds. The pictures are from headless Chrome that watched the page during the run.

- `3d-1-blocked.png`: the script agent failed and the backup model has the task.
- `3d-2-reroute-to-peer.png`: Sam's script agent wrote the scripts.
- `3d-3-rejected-second-attempt.png`: Lou's reviewer rejected the scripts; the task is with Sam's script agent again, with the hints.
- `3d-4-done.png`: the reviewer passed the scripts, the scheduler made the schedule, the run ended as done.
