---
title: Build settings
nav_order: 7
---

# Build settings

**Settings → Builds** (owners/admins, permission `settings:manage`) holds
the instance-wide knobs for the build worker. There is one set of values
per Kaiad instance — not per tenant — because every worker process
(embedded in the API with `SM_EMBED_WORKER=1`, or standalone) shares the
same build queue and the same build workspace disk.

![Settings → Builds: parallel-build limit select, live running/queued counts, build workspace disk, and the disk-sizing warning](/assets/screenshots/settings-builds.png)

## Parallel builds

| Field | Meaning |
|-------|---------|
| **Parallel builds** | How many builds may be in the `running` state at once across *all* worker processes. Integer **1–8**, default **1**. |
| **Running / Queued** | Live counts, refreshed every 5 s while the page is open. |
| **Build workspace disk** | Free and total space of the filesystem holding `KAIAD_DATA_DIR/builds`, where every build clones its repo and stores artifacts. Shown as *unavailable* when the API cannot stat that path. |
| **Last changed by** | The user who last saved the limit, and when. |

The same values are available over the API
(`GET`/`PUT /api/v1/admin/build-settings`, see the
[API reference]({% link reference/api.md %}#admin--build-settings)) and
through the MCP tools `get_build_settings` / `set_build_settings`.

### How the limit is enforced

- Every worker pass claims queued builds inside **one database
  transaction under an advisory lock**: it counts running builds and only
  claims when the count is below the limit. Several worker processes can
  therefore never exceed the limit together, even when they race.
- **One build per service.** A queued build is skipped while another
  build of the *same service* is running, so two commits of one service
  never build concurrently (the newer one waits; otherwise FIFO). Extra
  slots only pay off when several *different* services have work waiting.
- **Lowering the limit never kills a build.** Running builds finish
  normally; the worker simply stops claiming until enough of them complete
  that it is under the new limit. Workers pick up a changed limit within
  about 5 s.

### Disk sizing

A heavy build (for example a Rust project, or anything that compiles
large dependency trees) can need **~20–25 GB** of scratch space in the
build workspace. Keep

```
parallel builds × 25 GB  <  free space on the build workspace
```

The page always shows this advice, and turns it into a prominent
red warning when the value you have selected × 25 GB exceeds the free
space currently reported. Concurrent heavy builds that run out of disk
fail with out-of-disk errors rather than being throttled.

## Orphan recovery

Every running build stamps a heartbeat in the database every 30 s. If a
worker process dies mid-build (crash, redeploy, OOM kill), its builds stop
heart-beating. On its next pass any worker:

1. marks every running build with no heartbeat for **120 s** as
   `failed` with the reason `orphaned: worker stopped mid-build`
   (the reason is also appended to the build log), and
2. re-queues **one** replacement build at the same commit, branch and
   trigger — unless the service already has a newer build created after
   the orphan, in which case the newer build supersedes it and nothing is
   re-queued.

Orphaned builds therefore show up as a failed build immediately followed
by a fresh queued one for the same commit. The replacement obeys the
parallel-build limit and the one-per-service rule like any other build.

On a graceful shutdown the worker stops claiming, waits up to 30 s
(`BUILD_STOP_TIMEOUT_MS`) for in-flight builds, and leaves anything
still running to the orphan sweep of the next worker.

The related environment tunables are listed under
[Configure the control plane → Parallel builds]({% link getting-started/configure-control-plane.md %}#parallel-builds).
