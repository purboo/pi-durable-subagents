# Resource leases in 1.1

`pi-durable-subagents hold <resource> [--shared | --slots <n>] [--priority <n>] [--yield] [--expect <duration>] [--max-wait <s> | --no-wait] [--note <text>] -- <command…>` waits for a resource, runs the command, ends its remaining processes, then releases the lease. The command's exit status passes through unless the wrapper yields the resource.

`--priority <n>` accepts an integer from -100 through 100. The default is 0. Waiting requests rank by higher priority first, then by their original sequence number. A higher-priority request can overtake waiting requests, including an earlier exclusive waiter when the new request is compatible with the current holders. It always respects incompatible holders and the existing counted-slot limit. A no-wait request can overtake lower-priority waiters, but equal- or higher-priority incompatible waiters keep it out. No-wait requests never enter the waiting list. With equal priorities, requests retain the existing FIFO rules. Low-priority requests can starve if higher-priority requests keep arriving.

`--yield` makes a holder step aside when a live waiting request is blocked by that holder. This also applies to lower-priority waiters: yielding is a holder's explicit choice. Compatible requests and refused no-wait probes do not trigger it. The wrapper watches the resource directory and polls it, detects a waiter within the poll interval plus one second, stops its command and descendants, releases its ticket and exits 75. The command is not resumed or retried.

`--expect <duration>` records an estimated command duration. Use whole seconds, optionally followed by `s`, `m` or `h`: `90`, `90s`, `25m` and `2h`. The allowed range is one second through seven days inclusive (`604800s` or `168h`). This is informational: it does not impose a timeout or reserve a future slot. `leases` shows a holder as, for example, `machine held by W1/build (exclusive, 3m of ~25m)` and a waiter with `expects 25m`; hold's waiting message shows the same elapsed/expected duration for holders. Counted-lease listings show the expectation of their first waiter. `leases --json` includes `priority`, `yield: true` and `expectMs` on tickets when supplied. Unused fields remain absent; old tickets without a priority have priority 0.

Held commands inherit `DSA_HOLD=<resource>:<seq>`. Existing `DSA_EXEC` and `DSA_CALL` values pass through unchanged. Before releasing after command exit, yield, a forwarded signal followed by exit, or wrapper cleanup, hold sends TERM to the command's process group and all live processes carrying the exact tag, waits its grace period, then sends KILL and rescans. Cleanup stops once no such processes remain or five seconds have passed. If tagged processes survive the bound, it releases anyway and prints `hold: <n> processes tagged <tag> survived; releasing`. If a wrapper is killed, its command still keeps the lease; after the wrapper and command are gone, remaining tagged processes also keep its ticket live until a waiting wrapper reclaims and ends them before proceeding.

Linux discovers tags in `/proc/<pid>/environ`, so descendants that create a new process group or session are still ended. macOS uses the existing `ps` environment listing when it exposes the tag; otherwise cleanup falls back to the original process group. A process that clears its environment and leaves the original group can escape. Environment tags are not a security boundary. Tags contain the resource and sequence, so separate DSA homes on one machine should use distinct resource names to avoid matching each other's tags. Priorities take effect once all hold wrappers for the resource run 1.1.0.

Programs may classify these three exact line forms together with exit status 75 as a command that did not produce a verdict. The prefix and suffix of each line are stable; identity and duration text in the middle varies:

```text
hold: <resource> is not free now (…); not running the command (exit 75)
hold: <resource> still held by … after …; not running the command (exit 75)
hold: yielded <resource> to <who> after <age>; the command was stopped (exit 75)
```

The first two lines mean the command never started. The yield line means the command started and was stopped; its partial output is not a completed check result.
