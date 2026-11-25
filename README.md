# Pi customizations

This repository stores the user-level Pi settings, the Alt+P model picker binding, both Gruvbox themes, the workflow extension, the Claude Code bridge extension, and the compact transcript patch. The workflow extension provides `/advisor`, `/review`, `/agents`, hashline editing, project memory, interactive forms, language-server tools, and a debugger.

## Restore the configuration

From a fresh checkout, copy the saved configuration into Pi’s agent directory. If you already have settings or keybindings there, merge the corresponding JSON files to keep any newer preferences.

```sh
pi_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$pi_agent_dir"
cp -R agent/. "$pi_agent_dir/"
```

Configure your provider and credentials separately. The snapshot excludes credentials, provider files, session logs, project memory data, and worktrees.

## Language servers and debugger

Both tools use Pi’s project trust setting when starting a server or debug session. The extension discovers executables in project tool directories, `PATH`, `~/.local/bin`, and `~/.venv/bin`.

- Ask Pi to use `lsp` to find definitions and references, inspect symbols, check diagnostics, or preview a rename. `lsp status` lists detected servers for the current workspace. Set `apply: true` to apply a rename, file move with import updates, or edit-only code action.
- Configure LSP in `~/.pi/agent/lsp.json` or trusted project `.pi/lsp.json`. A `servers` object can override a built-in server or define one with `command`, `args`, `fileTypes`, and `rootMarkers`. Set `"diagnosticsOnWrite": true` at the top level to add diagnostics to successful write and edit results. Run `lsp reload` after changing the configuration.
- Ask Pi to use `debug` to launch a script or executable, set breakpoints, step, and inspect stack frames, variables, or expressions. The port supports stdio adapters for LLDB, GDB, and debugpy, plus attaching to an existing debugpy listener on localhost. A debugger launch uses the workspace or `PATH` Python for Python scripts. Use `python` to specify a different interpreter.
- On this machine the TypeScript server uses TypeScript 5.9, Pyright handles Python LSP, and `uv tool install debugpy` supplies `debugpy-adapter`. macOS may require Developer Tools authorization for LLDB to attach to a process.

Upstream workflow references are available in the [oh-my-pi LSP docs](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/lsp.md) and [debugger docs](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/debug.md).

## Claude Code bridge

The `claude-code` extension connects Pi to Claude Code's instructions, memory and sessions. It reads `~/.claude`, or `$CLAUDE_CONFIG_DIR`. Link it next to the workflow extension with `ln -s "$PWD/agent/extensions/claude-code" ~/.pi/agent/extensions/claude-code`, then run `/reload`.

- **Instructions.** Pi reads one context file per directory and prefers `AGENTS.md`, while Claude Code reads `CLAUDE.md` wherever one exists. The extension adds what Claude Code loads and Pi does not. That covers `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` in the working directory and above it, `~/.claude/CLAUDE.md`, and rules in `~/.claude/rules/` and `.claude/rules/`. It also adds every file brought in by an `@path` import, including imports inside the `AGENTS.md` files Pi loads, which Pi does not expand. Imports follow Claude Code: they resolve relative to the importing file, go at most four hops deep, are ignored in code spans and fenced code blocks, and from a project file reach outside the working directory only if Claude Code has approved external imports for the project. HTML comments are dropped. A subdirectory's instruction files and rules with `paths:` frontmatter load when a tool reads, edits or writes a file they cover (or `cat`/`head` shows a single file there), and load again after a compaction, as in Claude Code.
- **Memory.** Every Pi session gets the Claude Code auto-memory of its project in the system prompt: Claude Code's own memory instructions and the first 200 lines or 25 KB of `MEMORY.md`, the same cut Claude Code makes. The directory is `~/.claude/projects/<project>/memory`, where `<project>` is the checkout's top level (a linked worktree uses its main checkout) or the working directory outside git. The model saves memories in the same format and changes `MEMORY.md` only with the edit tool, because Claude Code sessions may edit it at the same time. An imported session keeps the memory directory Claude Code was using. `/cc memory` shows the connected directory. The `retain`, `learn` and `recall` tools of the workflow extension keep a separate Pi-only store, and the prompt points the model to the shared one.
- **Sessions.** `/cc` lists the Claude Code sessions of the current project and its worktrees, or of every project when the project has none, and continues the chosen session in Pi in the directory Claude Code used (for a removed worktree, the repository). The list marks sessions still running in Claude Code and sessions that already have a Pi copy. `/cc resume <id prefix|title|latest>` skips the picker and searches every session. `--all` lists or picks across all projects. `/cc list` only lists.
- **One Pi copy per session.** Each import is saved as Pi session `cc-<Claude Code session id>`, owner-only like the transcript. It goes where Pi's own `/new` saves sessions, so `/cc` does not work under `--no-session`. Running `/cc` again opens that copy unless Claude Code has moved on since. Then an untouched copy is replaced by a new import, and a copy continued in Pi is kept while Pi asks whether to open it or import Claude Code's newer state beside it. `--fresh` imports again in any case.
- **Budget.** `--budget 120k` sets the token budget for replayed messages (default `80k`, at most half the model's context window). For Claude models on the Anthropic API the replay is counted exactly with Anthropic's free token counter. Other models have no free counter, so the replay is estimated, within a few percent on GPT models. `--exact` counts it with two real requests instead.
- **What the import keeps.** It follows `claude --resume`: the active branch of the transcript, starting at the last compaction. Claude Code's summary becomes a Pi compaction entry. The newest messages that fit the budget are replayed, including every block of each response with its tool results, user images, and background task results. Bash, Read, Edit and Write appear under Pi's tool names, and thinking blocks are dropped. Prompts of the messages that did not fit are listed in the summary, which also names the transcript for deeper lookups. Common secret formats are redacted while the transcript is read, before any text is clipped: private keys, API and bot tokens, URL credentials, and `*_TOKEN=`-style assignments. A session that is still open in Claude Code is imported as a snapshot and is not synced afterwards.

Run the tests with `node --test agent/extensions/claude-code/`.

## Anthropic credit in the footer

The `anthropic-credit` extension estimates the remaining Anthropic API credit, displayed as `claude ~$142.30`. With `model-border` enabled, the balance appears at the right end of the metrics row. The figure turns yellow under $20 and red under $5.

Anthropic has no balance endpoint. The Console Billing page is the only place the credit is shown, the cost report needs an organization-scoped key and reports spend before credits are applied, and Messages responses carry rate limits but nothing about credit. So the figure is an estimate: `/balance <usd>` records the balance read from the Billing page, and the footer shows that amount minus what Pi has spent on the `anthropic` provider since, priced from Pi's model table (its rates match Anthropic's published prices). `/balance` alone shows the amount, the time it was set, the spend since and the number of calls. Run `/balance <usd>` again to correct drift, after a top-up, and when the monthly included credits refresh.

- **What counts.** Assistant messages of the `anthropic` provider in saved sessions: `~/.pi/agent/sessions` and the sessions of omp-workflow subagents in `~/.pi/agent/omp-workflow/agents`, which run without extensions. Each provider response counts once, so a forked session does not count twice. Runs with `--no-session`, in-memory subagents, and anything else that uses the same key are not counted.
- **Storage and refresh.** The balance and its time are in `~/.pi/agent/anthropic-credit.json`, shared by every Pi process. The footer refreshes at session start and after each turn, reading only the session files modified since the balance was set.

Run the tests with `node --test agent/extensions/anthropic-credit/`.

## Model name in the prompt border

The `model-border` extension moves the model from the footer to the prompt. The active model's id appears at the right end of the prompt's top border, opposite the `Working` status at the left end, and the footer's `(provider) model • thinking level` is dropped from the stats line. The thinking level is then shown only by the border's colour. The label follows model changes, is drawn in the border's colour, is shortened on narrow terminals and is dropped when the border has no room for it.

The label comes from replacing Pi's prompt editor with a `CustomEditor` subclass that keeps the built-in editor behaviour, so it conflicts with any other extension that replaces the editor. Pi uses the last editor loaded. Pi installs a fresh editor on every reload and session switch, so the extension keeps the submitted prompts and replays them into each new editor, which keeps the up arrow's history across `/reload` and `/new`. The footer hides the input, output, cache-read and cache-write token totals and shows the cache hit rate with a `🖫` prefix. Unloading the extension restores the original footer.

Run the tests with `node --test agent/extensions/model-border/`.

## Restore the compact transcript

```sh
python3 patch-pi-ui.py
```

The script targets the saved Pi 1.6.0 npm build. It verifies the installed bundles before writing and can be run again after reinstalling that build. The prompt uses the terminal’s native cursor and follows terminal focus reports. In tmux, this requires `focus-events on`. Use `python3 patch-pi-ui.py --undo` to restore the original bundles. For an installation outside `PATH`, pass `--package-dir` with the npm package directory. Restart Pi after applying or undoing the patch.
