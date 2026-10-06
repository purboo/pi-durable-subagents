# Changelog

## 1.0.0

The first and only planned major release.

- Durable subagent workflows for pi. Requests, executions and results are
  journaled; a crash of pi, the orchestrator or the machine resumes the same
  sessions without running a finished call again.
- `subagents` tool for the main agent: `agents`, `run` (single call, `tasks`,
  `chain`, or a workflow script with `runs.run` / `runs.all` / `emit` / `args` /
  `runs.input`), `send` (steer a running subagent, follow up a finished one,
  answer, switch model; `replaces` supersedes an earlier send), `stop`,
  `revise`, `resume`, `drain`, `status`. Each verb has one meaning; every
  refusal names what would work (agent names, call addresses). The
  completion notice carries each subagent's result.
- Questions (`ask`) and structured reports (`report`) inside subagents;
  hibernation releases slots while a question waits; generations continue an
  ended subagent's session.
- Model pools, provider slots and memory admission that are never exceeded;
  active-time timeouts; per-call and workflow usage budgets; worktree
  isolation, fork context, gates and output artifacts.
- Quitting pi (Ctrl+D, `/quit`, a closed terminal) pauses that session's
  running workflows so nothing more is spent; `resume` continues them in the
  same sessions. A crash or `kill -9` lets them run on. `"onQuit": "continue"`
  keeps them running after a quit too.
- TUI: summary line and dock above the editor, a framed list (`↓` or
  `/subagents`) with a live preview per agent that doubles as a control surface
  (steer, follow-up, stop, model, answer, resume from the list), watch view with
  the streaming response, steering, model and thinking switches; interaction
  cards in the main transcript.
- CLI: `smoke`, `chaos` (nine offline fault scenarios), `status`, `events`,
  `tail`, `start`, `resume`, `drain`, `stop`, `stop-all`, `prune`, `doctor`,
  `install-service`, `uninstall-service`.
- Compatible with pi-subagents 0.75.0 scripts and agent files (builtin agents
  adapted under MIT); `researcher` and `evidence-auditor` use whichever web
  extension is installed.
- Requires Node.js 22.19 or later and pi 1.0.x.
