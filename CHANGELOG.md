# Changelog

## 1.0.3

- Recovery delivers a call's task when an earlier execution ended before its
  subagent received it (for example, an orchestrator restart while the call
  waited for a provider slot). It used to send only "Continue the task", and
  the fresh subagent had to guess what the task was.

## 1.0.2

The first published release (1.0.0 and 1.0.1 were prepared but never
published).

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
- Model and thinking menus search fuzzily, by id or display name (`bedrock opus`
  finds `amazon-bedrock/claude-opus-4-5`). A requested model switch shows at
  once ("old → new, at the end of this step") until the subagent applies it.
- Calls waiting for a provider slot show as queued, with the model they asked
  for; the summary counts them apart from working ones.
- The dock is installed once per session: listed before another extension's
  editor bar (such as a powerline bar) in `packages`, it sits above that bar.
  `"ui": { "dockAt": "below" }` puts it below the editor.
- `/subagents` opens the list, like `↓` on an empty editor.
- A top-level `cwd` is the run's directory: relative workflow, input and call
  paths resolve against it.
- Install from npm, or from GitHub without a build step:
  `pi install git:github.com/purboo/pi-durable-subagents`.
