# claude-mods

Make your claude code look and feel better. Easier to read so you miss fewer things. 

## Installation

Clone the repo, then start Claude Code from its root with both mods loaded:

```sh
claude --plugin-dir ./glamour-dark --plugin-dir ./tool-lines
```

`--plugin-dir` loads a mod for that session only. To load them every time, add an alias to your shell config (`~/.zshrc` or `~/.bashrc`), pointing at where you cloned the repo:

```sh
alias claude='command claude --plugin-dir ~/path/to/claude-mods/glamour-dark --plugin-dir ~/path/to/claude-mods/tool-lines'
```
