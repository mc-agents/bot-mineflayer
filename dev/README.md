# Test server

A Minecraft server to run the tools against. Offline-mode, flat world, with the bot opped and in creative. Do not run it outside a dev environment.

```bash
docker compose -f dev/compose.yml up -d
```

It publishes **25577**, not 25565, because 25565 is often already taken. Override with `MC_PORT`.

The bot joins as `mcp_probe`, which compose ops at startup. Use `BOT_USERNAME` to match a different name.

```bash
node scripts/rpc-cli.ts            # listens on 8765, stands in for mcp-server
MCP_SERVER_HOST=127.0.0.1 pnpm dev # in another shell
```

```
connect 127.0.0.1 25577 mcp_probe
get-position
give-item {"itemName":"chest","count":1}
```

The world is flat at `y=-60` with structures and mob spawning off, so the pathfinder does not get stuck and a check cannot be skewed by terrain.

To exercise the GUI tools, place a chest and put a named item in it. `run-command` lives in mcp-server, so from the CLI it is `send-chat` with a slash command the bot is opped for:

```
give-item {"itemName":"chest"}
equip-item {"itemName":"chest"}
place-block {"x":3,"y":-60,"z":-6,"faceDirection":"down"}
open-container {"x":3,"y":-60,"z":-6}
read-window
```

Chunks are not loaded the instant a bot joins. Call `wait-ticks` once before any tool that takes coordinates.

```bash
docker compose -f dev/compose.yml down -v
```
