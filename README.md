# pi-herdr-fleet

Herdr-backed multi-agent orchestration for [Pi](https://github.com/earendil-works/pi).

[日本語](README.ja.md)

`pi-herdr-fleet` runs Pi agents in real [Herdr](https://herdr.dev/) panes.
Agents can use different models by role, work in parallel, message each other, and stay available for direct interaction when needed.

## Install

Install [Herdr](https://herdr.dev/) and [Pi](https://github.com/earendil-works/pi), then enable Herdr's Pi integration:

```bash
herdr integration install pi
```

Install the extension from GitHub:

```bash
pi install git:github.com/atriumnook/pi-herdr-fleet
```

Restart Pi after installation.

The official Herdr Agent Skill is not required. Herdr orchestration is handled by the extension.

## Usage

Start Pi inside Herdr and check the current fleet:

```text
/fleet
/fleet close
```

`/fleet` lists the fleet. `/fleet close` (or `/fleet close done`) closes non-interactive panes that Herdr still reports as `done`. Interactive, blocked, idle, and in-flight panes stay open.

Then delegate work normally:

```text
Use scout to inspect the authentication flow.
Ask reviewer to review the current diff independently.
```

The tools can also be called directly:

```text
agent_spawn({ role: "scout", task: "Inspect the authentication flow" })
agent_send({ target: "reviewer", message: "Please check src/auth/token.ts" })
agent_focus({ target: "planner" })
```

## Configuration

Copy [`config.example.json`](config.example.json) to `.pi/herdr-fleet.json` (project) and/or `~/.pi/agent/herdr-fleet.json` (user). Project overlays user; both overlay built-in defaults. Omit `defaultModel` / `defaultThinking` to inherit the current Pi session.

```json
{
  "maxConcurrent": 6,
  "maxDepth": 2,
  "defaultWaitTimeoutMs": 120000,
  "roles": {
    "scout": {
      "model": "provider/fast-model",
      "thinking": "medium"
    },
    "worker": {
      "model": "provider/strong-model",
      "thinking": "high"
    }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `runtime` | `"herdr"` | Only Herdr is supported. |
| `defaultModel` | unset (Pi session) | Fallback when the role has no `model`. |
| `defaultThinking` | unset (Pi session) | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`. |
| `maxConcurrent` | `6` | Caps agents in `starting` or `working`. Idle, done, and blocked do not count. |
| `maxDepth` | `2` | Nesting limit; see below. |
| `notifyOnComplete` | `true` | Wake the caller when a non-interactive turn settles. |
| `recentReadLines` | `160` | Lines fetched by `agent_read` and completion notify (minimum 20). |
| `defaultWaitTimeoutMs` | `120000` | `agent_wait` limit when the model omits `timeout_ms`. |
| `closeOnSettle` | `true` | Close non-interactive `idle`/`done` panes after the turn settles (and via the same age/recheck gates on sync). Set `false` to keep panes until `/fleet close`. |
| `roles.<name>` | `{}` | Per-role `model`, `thinking`, `worktree`, `interactive`, `spawning`. |

### Nesting (`spawning` × `maxDepth`)

- The Pi session that loaded this extension is depth `0`. Each spawn is `parentDepth + 1`.
- Spawn is refused when the current session's depth is `>= maxDepth`. Default `2` allows root → child → grandchild; the grandchild cannot spawn.
- A spawned agent gets `agent_spawn` only if its role has `spawning: true` (config or agent markdown) **and** `parentDepth + 1 < maxDepth`.
- Bundled `scout`, `planner`, `worker`, and `reviewer` set `spawning: false`, so only the root session can spawn unless you override a role.
- `interactive: true` (bundled `planner`) keeps the pane for humans: no automatic caller wake-up, and the pane is not auto-closed when the turn settles.

## Roles

| Role | Purpose |
| --- | --- |
| `scout` | Fast, read-only exploration |
| `planner` | Design and implementation planning |
| `worker` | Implementation and verification |
| `reviewer` | Independent code review |

Custom roles can be added under `.pi/agents/` or `~/.pi/agent/agents/` (project wins). Frontmatter accepts the same keys as `roles.<name>`: `model`, `thinking`, `worktree`, `interactive`, `spawning`.

Worktree isolation is opt-in and can be enabled per role or spawn.

## Tools

| Tool | Purpose |
| --- | --- |
| `agent_spawn` | Start a Pi agent in a Herdr pane |
| `agent_send` | Send a message to another fleet member |
| `agent_wait` | Wait for an agent explicitly |
| `agent_read` | Read recent output without changing focus |
| `agent_interrupt` | Interrupt the current turn |
| `agent_focus` | Focus an agent pane for manual interaction |
| `agent_list` | List known fleet members |

Normally, completion is tracked through Herdr events. `blocked` agents are left for human input rather than answered automatically.

## Development

```bash
git clone https://github.com/atriumnook/pi-herdr-fleet.git
cd pi-herdr-fleet
bun install
bun run check
```

To use the local checkout with Pi:

```bash
pi install "$(pwd)"
```

## Status

Live E2E tested with Herdr 0.8.2 and Pi 0.85.0.

Covered:
spawn, lifecycle completion, model routing, peer messaging,
agent controls, worktree isolation, concurrency and nesting.

Blocked and startup-blocked paths are covered by orchestrator unit tests (`agent_blocked`, `agent_not_ready`). Live Herdr approval-UI E2E is still not in the deterministic suite.

## Credits

Built on [Pi](https://github.com/earendil-works/pi) and [Herdr](https://herdr.dev/).
