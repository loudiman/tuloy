# Dashboard screenshots (ticket 7, 11 Nov 2026)

All are real runs of the conductor, made in headless Chrome against `node tests/harness/fake-run-server.ts`
(the scripted model answers; no real model call). The owner name on the page says so.

- `empty-state.png`: no run yet.
- `recovering-run.png`: the presenter injected an invalid output at the script agent (demo mode); the task is stalled and waits for retry 1 of 2.
- `done-run.png`, `done-run-whole-trail.png`: the same run after the retry; one handoff is open in the trail.
- `escalated-run.png`, `narrow-layout.png`: the reviewer rejected a script and the run ended as escalated.
