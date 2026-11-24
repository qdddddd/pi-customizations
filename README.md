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

## Restore the compact transcript

```sh
python3 patch-pi-ui.py
```

The script targets the saved Pi 1.6.0 npm build. It verifies the installed bundle before writing and can be run again after reinstalling that build. Use `python3 patch-pi-ui.py --undo` to restore the original layout. For an installation outside `PATH`, pass `--package-dir` with the npm package directory. Restart Pi after applying or undoing the patch.
