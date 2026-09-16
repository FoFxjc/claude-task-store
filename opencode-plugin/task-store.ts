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
// reliance on a runtime rewriting `.js` to a sibling `.ts`. OpenCode 1.18.25 runs
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
//       can be staged for delivery on the next chat call. A single
//       `task-store auto stage-instruction` call does the whole thing: the
//       core decides whether reconciliation is warranted and writes the
//       pending record in the same locked step, so a session that has just
//       lost ownership cannot stage anything.
//
//   - experimental.chat.system.transform
//       Fires on every chat call. Merges into the existing system prompt:
//         (a) the canonical `task-store resume` projection (always, when
//             state exists and is not archived)
//         (b) the session-attachment prompt (when this session is not the
//             recorded owner of auto-checkpoint; see src/attachment.ts)
//         (c) any pending reconciliation instruction staged by the
//             boundary hook, consumed in one shot
//       All three are appended to `output.system[0]` — never pushed as extra
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
//   - The CLI's dirty/reconcile gates are additionally filtered on
//     session-attachment ownership (src/attachment.ts); a fresh session in a
//     project with active task-store state neither dirties the runtime nor
//     receives a reconciliation instruction until the user explicitly opts
//     in via `task-store attach --yes` (or `--takeover --confirm`).
//
// Ownership marker:
//   The leading comment line is an exact-match identifier that install.sh
//   writes and uninstall.sh greps for. Editing it silently disables
// uninstall, which is the same safety pattern the runtime package uses.
//
// CLAUDE-TASK-STORE-OPENCODE-PLUGIN-V1
// do not edit: ownership marker read by install.sh / uninstall.sh

import {
  applySystemInjection,
  markDirtyOnTool,
  stageReconcileBoundary,
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

interface SystemTransformInput {
  // Present on the session-scoped call path. Absent on OpenCode's internal
  // `Agent.generate` path, where session-scoped injection must be skipped
  // rather than attributed to whichever session ran last.
  sessionID?: string;
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
  // There is deliberately NO plugin-level "current session" variable here.
  //
  // One plugin instance is created per project/process, and OpenCode runs
  // several sessions through it, so a shared mutable id is a cross-session
  // identity leak: whichever session touched the plugin last would decide who
  // the *next* session's tool calls, boundary checks, and prompt ownership
  // were attributed to. Each hook instead reads the session id from its own
  // input, which OpenCode 1.18.25 supplies on every one of them:
  //
  //   tool.execute.after                  { tool, sessionID, callID, args }
  //   event (session.idle)                properties: { sessionID }
  //   experimental.chat.system.transform  { sessionID, model }
  //
  // A hook whose input carries no usable id does nothing session-scoped. That
  // is the correct failure direction: doing nothing costs one missed prompt or
  // one dirty signal, while guessing costs another session's ownership.
  //
  // (`experimental.chat.system.transform` is also triggered internally with
  // `{ model }` and no sessionID — see Agent.generate — which is why the id is
  // optional there rather than required.)

  return {
    // ── Dirty signal ──────────────────────────────────────────────────────
    // No-op for read-only tool names; otherwise delegate to the
    // provider-neutral core. Never inspects tool arguments, never calls a
    // task-store mutation verb.
    //
    // The OpenCode session id is required by the CLI's intent-boundary
    // gate (src/attachment.ts). When it is missing the CLI no-ops the
    // call silently, which is the correct failure mode for a session that
    // has not yet opted in.
    "tool.execute.after": async (
      input: ToolExecuteAfterInput,
      _output: unknown,
    ): Promise<void> => {
      try {
        const sessionID = input.sessionID ?? "";
        // We deliberately do NOT self-exclude on tool-name substring the
        // way the Claude Code shell hook does: the Claude Code hook sees
        // a serialized Bash command string on stdin, and the cheap check
        // is to skip anything containing "task-store". The OpenCode hook
        // sees only the structured tool name (`bash`, `edit`, `write`,
        // ...), and a `bash` call that happens to invoke `task-store` is
        // still a real repository mutation (it ran a process). The CLI
        // self-exclusion inside the auto-checkpoint core handles the
        // semantic case.
        markDirtyOnTool(worktree, input.tool, sessionID);
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
        const sessionID = (event.properties?.sessionID as string | undefined) ?? "";
        // One call. The core decides *and* stages under its own lock, so this
        // session cannot stage an instruction after it has lost ownership —
        // which is what the previous `check`-then-write split allowed.
        stageReconcileBoundary(worktree, sessionID);
      } catch {
        // Never let a boundary handler break a session.
      }
    },

    // ── System prompt injection ──────────────────────────────────────────
    // Delivers three pieces of content, in this order:
    //   (1) the canonical resume projection, when state exists
    //   (2) the attach prompt, when this session is not the recorded owner
    //   (3) any pending reconciliation instruction staged by the boundary
    // All three are merged into the FIRST element of `output.system`
    // rather than pushed as new elements: OpenCode maps each entry of
    // `output.system` to its own `role: "system"` message for OpenAI-
    // compatible providers, and LiteLLM rejects a system message that is
    // not the first message. See applySystemInjection() for the full
    // rationale. The instruction is consumed exactly once.
    "experimental.chat.system.transform": async (
      input: SystemTransformInput,
      output: SystemTransformOutput,
    ): Promise<void> => {
      try {
        // The session id comes from this call's own input, never from state
        // left by another session's hooks. An empty id means the resume
        // projection is still injected (it is project-scoped) while the attach
        // prompt and the pending instruction are skipped (they are not).
        applySystemInjection(worktree, output.system, input?.sessionID ?? "");
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
