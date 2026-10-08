# cpu 叶子交付与基准

状态：实现完成，等待父任务 review；**idle-history CPU 与 RSS 两项验收仍未满足**。本叶子不声明 accepted。
基线 `ca1f59845c0fce0d499fc9fedbfc24fb7f846695`，分支 `feat/cpu`。

## 设计与范围

- 默认 containment 共享一个 ProcessTable；并发观察共享正在执行的扫描，观察缓存年龄从扫描开始计。
- fence 等待先前扫描结束，再使用请求之后启动的扫描；失败不产生新缓存。macOS 共享原始 ps 输出，各调用者单独按已知 exec 集合判别标签。
- Linux 已缓存环境的身份只读一次 stat；新身份读取 environ 后仍复查 start token。小型 `/proc/*/stat` 用同步读取，减少 libuv 往返；其他文件读取保持原行为。
- watcher 仅处理 session.jsonl、inbox 和未知文件名通知，10 ms 合并事件；进程扫描仅由 timer 触发。流式增量只更新接收时钟，完整限制检查最多约 1 秒一次。
- revision/terminal 使用不可变 entries 视图缓存；executor 的 has、usage、tracked 使用追加索引；sweep 在恢复时建立索引，之后只折叠新增记录。
- （评审后撤回）原先只持久化不带当前执行标签的 tracked 身份；因清除标签并脱离进程树的进程在重启后会漏 fence，1.0.18 恢复为持久化每个新身份。已知历史身份先与扫描中的 pid/start 匹配，再建立集合，避免为已消失身份分配字符串。
- 没有更改磁盘格式、版本号、CHANGELOG、其他 worktree 或用户 DSA home。

代码：`src/platform/{proctable,containment}.ts`、`src/types.ts`、`src/orchestrator/store.ts`、`src/orchestrator/executor/{index,indexes,observe,sweep,usage}.ts`。
回归：`test/unit/platform/snapshot.test.ts`、`test/unit/orchestrator/executor/{indexes,observe,robust}.test.ts`、`test/unit/orchestrator/store/store.test.ts`。

## 重现

Node 24；已有 node_modules；不要安装依赖。建议清除父执行继承的 DSA_EXEC：

```sh
nice -n 10 timeout 75s env -u DSA_EXEC node scripts/bench-orchestrator.ts idle-history
nice -n 10 timeout 75s env -u DSA_EXEC node scripts/bench-orchestrator.ts streaming
```

每个场景创建独立临时 DSA home、agent dir，使用 faux provider 和进程内 main()；正常退出清理自建目录、调用与 sleep 子进程。测量排除准备、恢复、3 秒预热和关闭，默认约 30 秒；只计算 orchestrator 所在进程的 CPU，内存为每秒采样均值。CPU profile 会增加开销，数值验收使用不带 profiler 的运行。

idle-history 默认 100 个已完成 workflow、300000 条 tracked，三份各 15000 条的大日志，其余均分；另有真实长睡 bash 调用。夹具使用真实 Store 创建元数据，同一 CRC journal 帧批量写入历史，包含 call/exec/fenced/sealed/done/attention；真实 openJournal 和 snapshotFromEntries 校验第一份历史，main 对全部历史执行真实恢复。支持 `--workflows=N --entries=N --large-entries=N --seconds=N`。

streaming 默认四个并发真实 pi 调用，长文本流和生成短命 sleep 的 bash，加 200 个自建 idle sleep；支持 `--idle-processes=N`。默认场景完整运行约 40 秒。`--large-entries=45000` 可恢复更偏斜的历史分布；该分布的基线曾超时，不应把超时视为成功测量。

基线在 `/tmp/dsa-cpu-baseline` 的独立 ca1f598 worktree 中运行，拷贝相同基准脚本并链接现有 node_modules；没有 stash/reset 用户改动。交付前移除临时 baseline worktree。

## 最终无 profiler 对比

下列四次运行串行完成，退出码均为 0；未与本叶子其他测试并发。共享主机仍可能有用户任务。原始日志位于 `/tmp/dsa-cpu-evidence/final-{baseline,after}-{idle,streaming}.log`。这些运行继承了父叶子 DSA_EXEC；包含此环境条件，不把它们描述为完全无其他标签的空机器测量。

| 场景 | 基线 CPU 核 | 修改后 CPU 核 | 基线 RSS MiB | 修改后 RSS MiB | 基线 heap MiB | 修改后 heap MiB | scans/s 基线 → 修改后 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| idle-history | 1.1430 | 0.0301 | 273.99 | 285.91 | 72.31 | 109.33 | 1.862 → 1.033 |
| streaming | 1.9447 | 0.0743 | 191.96 | 147.56 | 15.79 | 30.66 | 6.633 → 1.000 |

idle CPU 下降约 97.4%，但仍比 0.02 核目标高约 50%；RSS 增加约 4.3%。streaming CPU 下降约 96.2%，满足 0.15 核目标，RSS 降约 23.1%。已尝试物理快照共享、同步 proc stat、过滤已失效身份和提前构建 sweep 索引；继续降低历史索引常驻内存需要父任务确定下一里程碑，当前不扩展为 terminal journal 冷存储设计。

## Profile

保存完整 `.cpuprofile` 于 `/tmp/dsa-cpu-evidence/`，可用 DevTools 打开。采样覆盖准备、恢复、测量和清理，因此 decode/add 等准备帧不能算作稳态热点。

- 基线 idle（`baseline-idle-final.cpuprofile`）：revisionEntries 8.922 s，GC 4.088 s，sweepExecutions 1.524 s，ProcessTable.list 0.382 s。
- 最终 idle（`delivery-idle.cpuprofile`）：idle 34.381 s；主要非 idle 帧是夹具/恢复 decode 0.605 s、add 0.474 s、readFileUtf8 0.289 s；GC 0.182 s、ProcessTable.read 0.111 s。revisionEntries 和重复整历史扫描已不再是主要帧。
- 基线 streaming（`baseline-streaming.cpuprofile`）：GC 7.348 s，read 1.492 s，ProcessTable.list 1.463 s，readFileHandle 0.949 s，openFileHandle 0.844 s。
- 最终 streaming（`delivery-streaming.cpuprofile`）：idle 31.904 s；spawn 0.488 s（包含准备 200 个 sleep）、readFileUtf8 0.366 s、contentHash 0.170 s、ProcessTable.read 0.146 s、Containment.scan 0.129 s；GC 0.084 s。最终两个 profile 退出码均为 0，命令清除继承 DSA_EXEC。

## 验证与退出码

全部完整 stdout/stderr 和退出码保存在 `/tmp/dsa-cpu-evidence/` 的同名 `.log` / `.exit`，没有裁剪原始日志。

| 命令（均在 cpu worktree，特殊说明除外） | 结果 |
| --- | --- |
| `nice -n 10 timeout 60s npm run -s typecheck` | 0，`typecheck-final`；此前 90s 版本也为 0 |
| `nice -n 10 timeout 30s npm run -s lint:imports` | 0，`lint-final`；此前一次也为 0 |
| `nice -n 10 timeout 90s node --test test/unit/platform/snapshot.test.ts test/unit/orchestrator/executor/observe.test.ts test/unit/orchestrator/executor/robust.test.ts test/unit/orchestrator/store/store.test.ts` | 1，41/42；新增测试错误地要求 append 返回对象与冻结 entries 对象同引用。已修正，完整 unit 覆盖通过 |
| `nice -n 10 timeout 180s node --test test/unit` | 1，测试命令用法错误：Cannot find module .../test/unit；改为下面的 glob |
| `nice -n 10 timeout 240s node --test --test-concurrency=2 'test/unit/**/*.test.ts'` | 0，399/399，24.73 s，`unit-final` |
| `nice -n 10 timeout 360s node --test --test-concurrency=1 test/pi/executor/executor.test.ts test/pi/executor/session.test.ts 'test/pi/e2e/*.test.ts'` | 1，74/75，102.29 s，`pi-final`；唯一失败见下两行 |
| `nice -n 10 timeout 40s node --test --test-name-pattern='P9 report takes precedence without a settled event' /tmp/dsa-cpu-baseline/test/pi/executor/executor.test.ts` | 1，相同标签断言失败，`pi-baseline-inherited` |
| `nice -n 10 timeout 40s env -u DSA_EXEC node --test --test-name-pattern='P9 report takes precedence without a settled event' test/pi/executor/executor.test.ts` | 0，1/1，`pi-isolated-recheck` |
| `nice -n 10 timeout 10s git diff --check` | 0 |

真实 pi 的唯一失败来自 nativeSession 继承父叶子标签：executor.test.ts:318 预期 identity.tag 为 undefined，实际为当前 cpu 叶子 exec。ca1f598 同环境复现，去掉 DSA_EXEC 后当前代码通过；其余 74 项已有同树通过证据，没有重复整套测试。覆盖 hibernate/answer、follow-up、timeout/budget、stall、fence/recovery、suspend 与中断后的 session。

基准调试记录也保留：前两次 streaming 冒烟因请求 sseq 缺口退出 1，修正为独立 sender 的 sseq=1 后通过；第一版历史夹具逐条 fsync 的 180s 运行退出 124，随后三份 45000 tracked 的 bulk 基线 110s 运行退出 124。其创建的临时目录和进程已单独清理。其余已完成的冒烟、中间基准和最终四次无 profiler 基准退出码均为 0，不能用这些中间数据替代最终表格。

## 剩余限制与运行状态

- **未达标**：idle-history 约 0.030 核，目标约 0.020；该场景 RSS 比基线高约 12 MiB。没有通过更换测量窗口隐藏结果。
- Linux 实测；macOS 只有注入 ps 输出的共享/隔离/fence 回归，没有原生 macOS 性能验证。
- /proc stat 改用同步读取会短暂占用事件循环；本机约 538 个进程，已跑真实 timeout/ask/stall 回归。
- 没有 merge、push、tag、发布或触碰用户运行中的 orchestrator。代码提交后由父任务审核、整合与接受。
