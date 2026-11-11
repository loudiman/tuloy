# Tuloy

Tuloy ("keep going") runs a team of AI agents toward a goal and recovers by itself when a step fails. Each person runs their own Tuloy, and one Tuloy can give work to another.

## Language

### The run

**Conductor**:
The part of Tuloy that owns a run from the goal to its end, with no person in the loop.
_Avoid_: Orchestrator, manager, supervisor

**Goal**:
The one sentence of work that an owner gives to the conductor.
_Avoid_: Prompt, request, job

**Run**:
One attempt by the conductor to finish one goal. A run ends as done or as escalated.
_Avoid_: Session, execution, workflow

**Task**:
One unit of work in a run, owned by exactly one agent at a time.
_Avoid_: Step, node, job

**Task graph**:
The tasks of a run and which tasks must finish before which.
_Avoid_: Plan, pipeline, DAG

**Agent**:
A worker with one role (trend scout, script, reviewer, scheduler) that takes a task and returns an output.
_Avoid_: Bot, assistant, worker

**Handoff**:
The move of one agent's checked output to the next agent as its input.
_Avoid_: Hand-over, pass, transfer

### When things go wrong

**Recovery**:
What the conductor does after a task fails or stalls: retry, then re-route, then re-plan or escalate.
_Avoid_: Self-healing, error handling

**Re-route**:
To give a task to a backup with the same input. The backup is the owner's backup model first, and then a peer's agent.
_Avoid_: Failover, fallback, switch

**Escalated**:
The end of a run that the conductor could not finish. It is an honest stop, not a failure to hide.
_Avoid_: Aborted, crashed, failed run

**Stuck reason**:
The short plain sentence that says why a task is not moving and what the conductor did about it.
_Avoid_: Error message, status text

**Injection**:
A failure that the operator causes on purpose in demo mode, to show a recovery.
_Avoid_: Chaos test, fault, simulated outage

### Between people

**Owner**:
The person a Tuloy belongs to and works for.
_Avoid_: User, operator, account

**Peer**:
Another owner's Tuloy on your allowed list. A peer can take one task or a full goal from you, and can give one to you.
_Avoid_: Partner, node, instance, remote Tuloy

**Outside agent**:
An agent that belongs to another person and does not run in your Tuloy. It can be an agent that a peer lends, or any agent that speaks A2A.
_Avoid_: Remote agent, external agent, third-party agent

**Allowed list**:
The peers and outside agents that an owner approved before a run, each with its address and key. Nothing outside the list gets work or gives work, and a peer on the list can use all of the owner's agents and the conductor.
_Avoid_: Whitelist, registry, contacts

**Invite**:
A link that one owner sends to another. When the other owner opens it, each Tuloy goes on the other's allowed list.
_Avoid_: Pairing code, connection request, friend request
