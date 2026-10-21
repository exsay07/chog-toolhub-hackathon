# Farming software drop-in location

Place the Perpl and Bulk farming software you provide here, **unmodified**:

```
apps/agent/adapters/vendor/perpl/   ← your Perpl software
apps/agent/adapters/vendor/bulk/    ← your Bulk software
```

Nothing in these folders is executed automatically. Integration steps (see docs/IMPLEMENTATION_PLAN.md, milestone M7):

1. Review every file: language, dependencies, entry points, network calls, file I/O, credential handling.
2. Remove hard-coded secrets; move per-user settings into `PerpsTaskConfig` + agent-local encrypted config.
3. Refactor global state into per-task instances (one task = one isolated child process / instance).
4. Implement `FarmingAdapter` in `src/adapters/<platform>.ts`, launching via `spawnIsolated()`
   (no shell, scrubbed env, task-private working directory).
5. Add concurrency tests (two tasks, different configs/keys, no shared files or logs).
6. Flip the adapter from `AwaitingSoftwareAdapter` to the real one in `src/adapters/index.ts`.
