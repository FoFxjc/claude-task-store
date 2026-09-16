# State codec and migration contract

This document fixes the read/write contract for `.claude-task/state.json`
as a stable, named boundary. It is the single source of truth for the
behaviour the on-disk file is allowed to exhibit. The implementation
lives in [`src/codec.ts`](../src/codec.ts), [`src/storage.ts`](../src/storage.ts),
and [`src/types.ts`](../src/types.ts); this document is the contract
those implementations honour.

## Definitions

- **Disk schema** — the JSON shape on disk in `.claude-task/state.json`,
  identified by `version`.
- **Canonical in-memory schema** — the v2 {@link TaskState} represented
  by the TypeScript types in `src/types.ts`.
- **`decodeDiskState(raw)`** — the codec entry point used by readers
  (currently `codec.validateState`). Returns a canonical in-memory
  state or throws `codec.StateError`.
- **`encodeDiskState(state)`** — the codec entry point used by writers
  (`storage.writeState` already does this implicitly by
  `JSON.stringify`). The canonical in-memory state is written as
  the current disk schema.

## Supported on-disk readers

The codec recognises two disk schemas:

| `version` | Status | Reader behaviour |
| --- | --- | --- |
| `"1"` (legacy) | read-only | Migrated in memory to canonical v2; the file is **not** modified. |
| `SCHEMA_VERSION` (current) | full read | Validated field-by-field as the canonical v2 shape. |
| anything else | refused | `Unknown schema version: <v>` thrown. **Fail closed.** |

Unknown **future** schema versions never auto-migrate. They throw so
that an agent or operator can decide what to do, not the codec silently
guessing.

## Writer rules

After any successful write path (any of `storage.writeState`,
`batch.commitBatch`, `batch.compareAndWriteState`, or
`stale.repairState`):

- The persisted file uses the **current** disk schema. A v1 file
  persisted through a writer becomes v2.
- The canonical in-memory representation is what gets persisted (the
  file is the byte form of that state).
- `state.revision` advances by **exactly one** for the mutation
  (writers stamp the new revision before persistence).
- `state.updated_at` is refreshed for the state and (unless the writer
  opted out via `touchActiveTopic = false`) the active topic's
  `updated_at`. `updated_by` is set when supplied.
- One history entry is appended (the codec does not interpret the
  event discriminator; that's the caller's job). The history append
  is outside the byte-for-byte durability contract of the canonical
  state, so a partial system crash between the rename and the append
  is recoverable from `state.json` alone.

`stale.repairState` is the special-case writer that walks
`history.jsonl` in reverse to find a validatable snapshot and writes
it back. It is the only writer that reads from history rather than
from memory; the rest of the rules above apply unchanged.

## Read-only invariants

Read paths (`storage.readState`, direct `codec.decodeDiskState`,
`codec.getActiveTopic`, etc.):

- **No rewrites.** A `readState` on a v1 file does not touch the
  file. Verified by `tests/multi_topic_test.sh`:
  *read-only migration does not dirty Git-trackable state*.
- **No eager migration.** v1 reads do not trigger a v1→v2 rewrite.
  The rewrite fires on the next normal write.
- **No mid-state mutation.** The codec translates `raw → canonical`
  immutably from the caller's perspective; the in-memory state is a
  fresh object tree.

## Lossiness rules

Across migration v1 → v2:

- Semantic fields (`goal`, `status`, `current_task`, `tasks`,
  `decisions`, `blockers`, `next_action`, `created_at`, `updated_at`)
  are preserved.
- Synthetic fields added later and missing on the v1 file are
  populated (`active_topic = DEFAULT_TOPIC`, `decisions = []`,
  `blockers = []`, `next_action = null` defaults, `updated_at`
  falling back to `created_at` when absent).
- `revision` is preserved when present on the v1 file; otherwise it
  defaults to `0` so the read is consistent with the in-memory v2
  shape.

Lossiness in the *other* direction (v2 → v1) is **not supported** —
the project does not provide a downgrader. Trying to read a v2 disk
file through a v1-only reader is out of scope.

## Concurrency

`--expect-rev` and `compareAndWriteState` rely on `lock.withStoreLock`
to make the read-compare-write atomic against other CLI invocations.
The codec itself is not concurrency-aware; locking is the caller's
responsibility and only the CLI wraps every mutating command.

Direct library callers that mutate without going through
`withStoreLock` race with other writers; that limitation is the
contract for direct-API users, not a bug in the codec.

## Version-introduction rules

When a new disk schema is added in the future:

1. Bump `SCHEMA_VERSION` in `types.ts`.
2. Extend `codec.validateState` to recognise the new version
   (alongside the existing branch on `s.version === '1'`).
3. Add a migration step if any pre-existing on-disk schema needs to
   be supported alongside it.
4. Add a regression test under `tests/multi_topic_test.sh` (or a
   successor) that covers read-only migration, first-write lossless
   persistence, and the no-rewrites invariant.
5. Update this document with the new schema row in
   *Supported on-disk readers*.

The default behaviour for unknown versions remains *fail closed*.

## Verification

The existing regression `tests/multi_topic_test.sh` covers the
behaviour this contract requires end-to-end:

```
✓ version-1 state is readable as the default topic
✓ read-only migration does not dirty Git-trackable state
✓ first normal write persists a lossless schema-v2 migration
```

It runs against the real shell binary, against real
`.claude-task/state.json` reads, and against git-state diffing.
