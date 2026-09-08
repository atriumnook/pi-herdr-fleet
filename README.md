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
```

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

Project settings go in `.pi/herdr-fleet.json`. User settings go in `~/.pi/agent/herdr-fleet.json`.

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

See [`config.example.json`](config.example.json) for the available options. `defaultWaitTimeoutMs` (120000) bounds `agent_wait` when the model omits `timeout_ms`.

## Roles

| Role | Purpose |
| --- | --- |
| `scout` | Fast, read-only exploration |
| `planner` | Design and implementation planning |
| `worker` | Implementation and verification |
| `reviewer` | Independent code review |

Custom roles can be added under `.pi/agents/` or `~/.pi/agent/agents/`.

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

Blocked/startup-blocked flows are not yet covered by deterministic E2E tests.

## Credits

Built on [Pi](https://github.com/earendil-works/pi) and [Herdr](https://herdr.dev/).
