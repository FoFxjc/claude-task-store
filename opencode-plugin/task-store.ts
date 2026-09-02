// claude-task-store: OpenCode plugin
//
// Thin adapter that reuses the existing task-store CLI and provider-neutral
// auto-checkpoint core. Runs as an auto-discovered plugin from
// .opencode/plugin/task-store.{ts,js}; OpenCode discovers it without any
// opencode.json change.
//
// IMPORTANT: this file exports ONLY a default function. OpenCode's plugin
// loader iterates over every export of a plugin file and treats each as a
// candidate Plugin — so helper functions must live in a separate sibling
// module (`./task-store/injection.ts`) that this file imports.
//
// Packaging contract — the import specifier names the file that is actually
// installed, extension included:
//
//   install.sh copies      opencode-plugin/task-store/injection.ts
//                     ->   .opencode/plugin/task-store/injection.ts
//   this file imports      ./task-store/injection.ts
//
// So the specifier resolves to a path that exists on disk verbatim, with no
// reliance on a runtime rewriting `.js` to `.ts`. OpenCode 1.18.25 runs
// plugins under Bun, and Bun does happen to remap a missing `.js` to a
// sibling `.ts` — but that is an implementation detail of one runtime, not a
// contract, and it makes the installed tree self-inconsistent (an import of
// a file that is not there). Naming the real extension is deterministic
// under Bun, under `bun build`, and under anything else that can read the
// directory. Verified against the real binary: the plugin loads and the
// hooks fire with no module-resolution warning or error.
//
// This costs one tsconfig flag (`allowImportingTsExtensions`, valid because
// tsconfig.opencode.json is noEmit — the adapter is typechecked, never
// compiled) and no bundler, no build step, and no duplicated logic.
//
// Discovery, verified against the opencode 1.18.25 binary's own glob:
//   `.opencode/{plugin,plugins}/*.{ts,js}` — a single level, so the helper
//   under `task-store/` is imported but never itself loaded as a plugin.
//
// Lifecycle:
//   - tool.execute.after
//       Cheap, runs after every tool call. For tool names that are not in
//       the read-only allow-list, the plugin calls the existing provider-
//       neutral dirty marker via `task-store auto mark-dirty`. This is the
//       OpenCode analog of Claude Code's `PostToolUse` hook.
//
//   - event()  (filter: session.idle)
//       Fires when the agent finishes responding and the session goes idle.
//       This is the OpenCode analog of Claude Code's `Stop` hook and is the
//       smallest reliable boundary at which a reconciliation instruction
//       can be staged for delivery on the next chat call. When the
//       existing CLI decides reconciliation is warranted, the instruction
//       text is staged to a pending file.
//
//   - experimental.chat.system.transform
//       Fires on every chat call. Merges into the existing system prompt:
//         (a) the canonical `task-store resume` projection (always, when
//             state exists and is not archived)
//         (b) any pending reconciliation instruction staged by the
//             boundary hook, consumed in one shot
//       Both are appended to `output.system[0]` — never pushed as extra
//       array elements, because OpenCode turns each element into its own
//       `role: "system"` message for OpenAI-compatible providers and
//       LiteLLM requires system messages to come first.
//       This is also the OpenCode analog of Claude Code's SessionStart.
//
//   - experimental.session.compacting
//       Intentionally a no-op. The task store is the source of truth for
//       execution state; duplicating its contents into the conversation
//       summary would couple compaction back to a summary that itself
//       consumes context. After compaction, the next chat call re-injects
//       fresh state via system.transform.
//
// Constraints:
//   - No external npm dependencies; uses node: built-ins only so the plugin
//     loads inside OpenCode without modifying the target project's
//     package.json.
//   - State is read fresh from disk on every chat call (with an mtime-keyed
//     cache), so each session sees the current checkpoint even after long
//     pauses or across restarts.
//   - Failures degrade silently. A broken state file or missing CLI must
//     never break a coding session — the resume is a navigation aid, not a
//     requirement for the rest of OpenCode to function.
//
// Auto-checkpoint semantics:
//   - Default OFF (same as Claude Code). When off, every code path here is
//     a no-op because the underlying CLI core no-ops.
//   - When conservative, dirty marking only records that work may have
//     happened — it never infers completion, decides, blocks, or invents
//     a next_action.
//   - Reconciliation instruction text comes verbatim from the CLI core
//     (src/autocheckpoint.ts:RECONCILE_INSTRUCTION); the plugin never
//     paraphrases it.
//
// Ownership marker:
//   The leading comment line is an exact-match identifier that install.sh
//   writes and uninstall.sh greps for. Editing it silently disables
//   uninstall, which is the same safety pattern the runtime package uses.
//
// CLAUDE-TASK-STORE-OPENCODE-PLUGIN-V1
// do not edit: ownership marker read by install.sh / uninstall.sh

import {
  applySystemInjection,
  markDirtyOnTool,
  checkReconcileBoundary,
  writePendingReconciliation,
} from "./task-store/injection.ts";

interface PluginInput {
  // OpenCode's PluginInput exposes both worktree (project root) and
  // directory (cwd). We deliberately use worktree: the resume must reflect
  // the project's canonical state, not whatever subdirectory opencode was
  // launched from.
  worktree: string;
  directory: string;
}

interface SystemTransformOutput {
  system: string[];
}

interface BusEvent {
  type: string;
  properties?: Record<string, unknown>;
}

interface EventInput {
  event: BusEvent;
}

interface ToolExecuteAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: unknown;
}

const TaskStoreOpenCodePlugin = async ({ worktree }: PluginInput) => {
  return {
    // ── Dirty signal ──────────────────────────────────────────────────────
    // No-op for read-only tool names; otherwise delegate to the
    // provider-neutral core. Never inspects tool arguments, never calls a
    // task-store mutation verb.
    "tool.execute.after": async (
      input: ToolExecuteAfterInput,
      _output: unknown,
    ): Promise<void> => {
      try {
        // We deliberately do NOT self-exclude on tool-name substring the
        // way the Claude Code shell hook does: the Claude Code hook sees
        // a serialized Bash command string on stdin, and the cheap check
        // is to skip anything containing "task-store". The OpenCode hook
        // sees only the structured tool name (`bash`, `edit`, `write`,
        // ...), and a `bash` call that happens to invoke `task-store` is
        // still a real repository mutation (it ran a process). The CLI
        // self-exclusion inside the auto-checkpoint core handles the
        // semantic case.
        markDirtyOnTool(worktree, input.tool);
      } catch {
        // Never let an injection failure break a session.
      }
    },

    // ── Reconciliation boundary ──────────────────────────────────────────
    // `session.idle` is the smallest reliable boundary at which OpenCode
    // surfaces a model-facing continuation hook. There is no exact analog
    // of Claude Code's `Stop` `additionalContext` channel at this event,
    // so we stage the instruction to a pending file and let the next
    // `experimental.chat.system.transform` deliver it.
    event: async ({ event }: EventInput): Promise<void> => {
      try {
        if (event.type !== "session.idle") return;
        const decision = checkReconcileBoundary(worktree);
        if (decision.reconcile && decision.instruction !== null) {
          writePendingReconciliation(worktree, decision.instruction);
        }
      } catch {
        // Never let a boundary handler break a session.
      }
    },

    // ── System prompt injection ──────────────────────────────────────────
    // Delivers two pieces of content, in this order:
    //   (1) the canonical resume projection, when state exists
    //   (2) any pending reconciliation instruction staged by the boundary
    // Both are merged into the FIRST element of `output.system` rather than
    // pushed as new elements: OpenCode maps each entry of `output.system` to
    // its own `role: "system"` message for OpenAI-compatible providers, and
    // LiteLLM rejects a system message that is not the first message. See
    // applySystemInjection() for the full rationale. The instruction is
    // consumed exactly once.
    "experimental.chat.system.transform": async (
      _input: unknown,
      output: SystemTransformOutput,
    ): Promise<void> => {
      try {
        applySystemInjection(worktree, output.system);
      } catch {
        // Never let an injection failure break a session.
      }
    },

    // Compaction: no-op by design. See the file header for the rationale.
    "experimental.session.compacting": async (): Promise<void> => {
      // intentionally empty
    },
  };
};

export default TaskStoreOpenCodePlugin;
