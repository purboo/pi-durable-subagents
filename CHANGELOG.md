# Changelog

## 1.0.1

- Model and thinking menus search fuzzily, by id or display name (`bedrock opus`
  finds `amazon-bedrock/claude-opus-4-5`); the thinking menu says what it searches.
- A requested model switch shows at once in the list and the watch header
  ("old → new, at the end of this step") until the subagent applies it;
  switch rejections read in plain words.
- Calls waiting for a provider slot show as queued, with the model they asked
  for, instead of "thinking"; summaries count queued apart from working.
- A row is always one terminal line: multi-line commands or names no longer
  break the panel border.
- `/subagents` opens the list; typing with the list open goes to pi's editor;
  the selected row is marked with `›`.
- A top-level `cwd` is the run's directory: relative workflow, input and call
  paths resolve against it.
- Install from GitHub without a build step:
  `pi install git:github.com/purboo/pi-durable-subagents`.
- Robustness: a resumed subagent applies its model before its first turn; a
  failed process-table scan no longer ends a live subagent's observation; the
  orchestrator starts through symlinked paths (macOS `/var`); Node.js 22.19 is
  the minimum (older Node disables execution with a message).

## 1.0.0

The first release.

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
