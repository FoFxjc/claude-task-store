// claude-task-store: OpenCode plugin
//
// Thin adapter that reuses the existing task-store CLI to inject the canonical
// `task-store resume` projection into every chat call. Runs as an
// auto-discovered plugin from .opencode/plugin/task-store.{ts,js}; OpenCode
// discovers it without any opencode.json change.
//
// IMPORTANT: this file exports ONLY a default function. OpenCode's plugin
// loader iterates over every export of a plugin file and treats each as a
// candidate Plugin — so helper functions must live in a separate sibling
// module (`./task-store/injection.ts`) that this file imports.
//
// Lifecycle:
//   - experimental.chat.system.transform
//       Read .claude-task/state.json in the project worktree. If present and
//       not archived, shell out to the project-local CLI at
//       .claude/task-store/bin/task-store.js resume --root <worktree> and
//       append the output to the system prompt. This fires on the first user
//       message of a fresh session, which is exactly when a Claude Code
//       SessionStart hook would fire, so the resume lands without replaying
//       the prior conversation.
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
// Ownership marker:
//   The leading comment line is an exact-match identifier that install.sh
//   writes and uninstall.sh greps for. Editing it silently disables
//   uninstall, which is the same safety pattern the runtime package uses.
//
// CLAUDE-TASK-STORE-OPENCODE-PLUGIN-V1
// do not edit: ownership marker read by install.sh / uninstall.sh

import { buildResumeInjection } from "./task-store/injection.js";

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

const TaskStoreOpenCodePlugin = async ({ worktree }: PluginInput) => {
  return {
    "experimental.chat.system.transform": async (
      _input: unknown,
      output: SystemTransformOutput,
    ): Promise<void> => {
      try {
        const resume = buildResumeInjection(worktree);
        if (resume !== null && resume.length > 0) {
          output.system.push(resume);
        }
      } catch {
        // Never let an injection failure break a session. Resume is a
        // navigation aid; OpenCode itself is the system.
      }
    },

    // Compaction: no-op by design. See the file header for the rationale.
    "experimental.session.compacting": async (): Promise<void> => {
      // intentionally empty
    },
  };
};

export default TaskStoreOpenCodePlugin;
