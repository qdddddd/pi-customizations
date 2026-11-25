# Pi customizations

This repository stores the user-level Pi settings, the Alt+P model picker binding, both Gruvbox themes, the workflow extension, and the compact transcript patch. The workflow extension provides `/advisor`, `/review`, `/agents`, hashline editing, project memory, interactive forms, language-server tools, and a debugger.

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
