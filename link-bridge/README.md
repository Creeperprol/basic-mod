# Agent Link bridge (link-bridge)

The cross-CLI half of Agent Link: works with any MCP-capable CLI. The Claude Code half is the `session-link` plugin.

A tiny MCP server (no dependencies, Node 18+) that lets coding-agent sessions on one machine — Claude Code, Codex, Qwen Code, anything that speaks MCP — find and message each other, and lets one session host and hand out work.

State is plain files under `~/.session-link` (override with `LINK_HOME`). Nothing leaves the machine.

## Tools

| Tool | What it does |
|---|---|
| `link_peers` | List the other running sessions (name, CLI, folder) |
| `link_tell` / `link_tellall` | Message one session (name or id prefix) or all |
| `link_inbox` | Read and clear what was sent to you; `wait_seconds` waits for something |
| `link_host` | Become the host (or stop) |
| `link_assign` | Host: give a task to a worker or `all` |
| `link_report` | Worker: send a task's result back |
| `link_board` | Host: show tasks; `clear` drops finished ones |
| `link_rename` | Host: rename a worker as listed here |

A worker only obeys tasks and renames from the registered host. Sessions that stop (or stop answering for 60s) leave the list.

## Add it to each CLI

```
claude mcp add link --scope user -e LINK_CLI=claude -- node /path/to/server.mjs
codex mcp add link --env LINK_CLI=codex -- node /path/to/server.mjs
qwen mcp add link node /path/to/server.mjs -e LINK_CLI=qwen --trust
agy mcp add --env LINK_CLI=agy link /path/to/node /path/to/server.mjs
```

Codex asks before each MCP call; for hands-off use add `default_tools_approval_mode = "approve"` under `[mcp_servers.link]` in `~/.codex/config.toml`.

## How a task reaches a worker

Other CLIs cannot be pushed to: a message sits in the worker's inbox until it calls `link_inbox`. So a worker session needs to be told to check, for example "wait for work with link_inbox (wait_seconds 100), do any task, then call link_report". Inside Claude Code the separate `session-link` plugin does push delivery between Claude sessions.

## Test

`node --test test.mjs` runs a fake Claude, Codex and Qwen session through find, message, host, assign, report, board, rename and leave.

## Antigravity CLI (`agy`, tested on 1.4.4)

`agy` joins the same way as the others (`agy mcp add` above; `agy mcp list` should show `link` enabled). A Claude Code, Codex or Qwen host then sees it in `link_peers` as `agy-<folder>-<id>  [agy]`, hands it work with `link_assign`, and reads the result with `link_inbox` (verified end to end: Claude host -> agy worker -> `RESULT ... 391`, two tasks in a row to one worker).

Start a worker with the launcher (it builds the prompt that makes agy wait on `link_inbox`, do each task and answer with `link_report`):

```
./agy-worker.sh -d /some/trusted/folder -m gemini-3.8-flash-low       # headless background worker
./agy-worker.sh -d /some/trusted/folder -m claude-sonnet-4-6 -w        # interactive Terminal window
./agy-worker.sh -n ...                                                  # dry run: print the command
```

Things that bite:
- **Permissions.** Headless (`-p`) agy cannot prompt, so any tool it has no rule for is auto-denied and the session ends with "a tool required the ... permission". Allow only what a worker needs in `~/.gemini/antigravity-cli/settings.json`, one rule per tool, no wildcards: `"permissions": {"allow": ["mcp(link/link_inbox)", "mcp(link/link_report)", "mcp(link/link_peers)", "mcp(link/link_tell)"]}`. A task that needs a shell needs a `command(<prefix>)` rule you have checked, or run the worker interactively (`-w`) and approve at the keyboard. `--dangerously-skip-permissions` auto-approves everything; avoid it.
- **Trust question.** Like Claude Code, an interactive agy window in a folder it does not trust yet stops at "Do you trust the contents of this project?" (Yes, I trust this folder / No, exit) and a worker there never starts. Headless (`-p`) runs do not ask. Trusted folders are listed under `trustedWorkspaces` in the same settings file (`/tmp` is on this machine). `agy-worker.sh -w` checks that list first (read-only) and refuses with the reason; it never trusts a folder for you, that answer is yours to give.
- **Models.** `agy models` lists them (here: `gemini-3.8-flash-low|medium|high`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`). `--mode auto` is not available on this account.
- **Pull, not push.** Like Codex and Qwen, an agy session only sees a task when it calls `link_inbox`, which is why the launcher's prompt loops on it. After two empty waits (about 200 s) the worker stops; start another or give it work sooner.

### Make an image with agy, agent-style
`./agy-image.sh [-o out.jpg] [-m model] [-t seconds] "what the image shows"` starts a headless agy, asks it to use its `generate_image` tool once, waits for the file path, copies the image to `-o` (default `~/Projects/agy-images/`), prints the final path and lets agy exit. No window, no MCP, no permission rule needed for this tool in headless mode. Verified twice (a navy NFC tag, a hand tapping a phone to a pink tag; about 30-40 s each). It fails clearly when agy returns no image, for example `429 RESOURCE_EXHAUSTED` when the account's image quota is used up (hit on the third request in a row).

## Codex as a one-shot agent (`codex-agent.sh`, tested on codex-cli 0.162.1)

`./codex-agent.sh [-d dir] [-m model] [-s read-only|workspace-write] [-t seconds] [-o file] "the task"` runs `codex exec` for one task, prints its final message and lets it exit, the way a subagent would. Nothing stays running.

- **Safe by default:** read-only sandbox, no approval bypass, session not kept on disk (`--ephemeral`). `workspace-write` is opt-in with `-s`; `danger-full-access` and the bypass flags are deliberately not offered.
- **Verified:** "17 times 23" returned `391` in 12 s; a request to create a file under read-only was refused by the sandbox and reported honestly (8 s, no file); under `workspace-write` the file was created (34 s).
- **Persistent worker instead?** A Codex session that already has the `link` MCP server (see "Add it to each CLI") can be driven with `link_assign` / `link_inbox` like the other CLIs; use `codex-agent.sh` for fire-and-forget tasks.

