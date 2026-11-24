# Pi customizations

This repository stores the user-level Pi settings, the Alt+P model picker binding, both Gruvbox themes, the workflow extension, and the compact transcript patch. The workflow extension provides `/advisor`, `/review`, `/agents`, hashline editing, project memory, and interactive forms.

## Restore the configuration

From a fresh checkout, copy the saved configuration into Pi’s agent directory. If you already have settings or keybindings there, merge the corresponding JSON files to keep any newer preferences.

```sh
pi_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$pi_agent_dir"
cp -R agent/. "$pi_agent_dir/"
```

Configure your provider and credentials separately. The snapshot excludes credentials, provider files, session logs, project memory data, and worktrees.

## Restore the compact transcript

```sh
python3 patch-pi-ui.py
```

The script targets the saved Pi 1.6.0 npm build. It verifies the installed bundle before writing and can be run again after reinstalling that build. Use `python3 patch-pi-ui.py --undo` to restore the original layout. For an installation outside `PATH`, pass `--package-dir` with the npm package directory. Restart Pi after applying or undoing the patch.
