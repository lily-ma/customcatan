# Catan Enhanced

Catan Enhanced turns a shared display into an interactive Catan table and uses
phones as synchronized game controllers. It combines a PixiJS board, a
mobile-friendly control surface, and a small Node.js WebSocket server.

## Features

- Randomized 19-hex islands with terrain, number tokens, water, and a robber
- Two-to-four-player setup with turn selection and live scoring
- Valid placement highlighting for towns, cities, and roads
- Dice production highlights and robber movement after a seven
- Knight tracking, Largest Army, and Longest Road scoring
- Multiple phone controllers synchronized with the shared board
- Persistent game state across server and container restarts
- Multi-architecture Docker images for Raspberry Pi and desktop systems

## Quick start with Docker

Requirements: Docker Engine with the Docker Compose plugin.

```sh
git clone https://github.com/lily-ma/customcatan.git
cd customcatan
docker compose up -d --build
```

Open the following pages from devices on the same network:

| Page | Address | Purpose |
| --- | --- | --- |
| Board | `http://<server-ip>:8080/board` | Shared television or table display |
| Controls | `http://<server-ip>:8080/controls` | One or more player phones |
| Health | `http://<server-ip>:8080/api/health` | Server and board connection status |

For a local machine, replace `<server-ip>` with `localhost`. Stop the service
with `docker compose down`. Game state remains in the `catan-data` Docker volume.

## Run without Docker

Requirements: Node.js 22 and npm.

```sh
npm ci
npm run build
npm start
```

The production server listens inside the container on port `8080`; the Pi deployment exposes it on host port `8081`. Override its configuration with:

- `PORT`: HTTP and WebSocket port
- `DATA_DIR`: directory containing the persisted `game-state.json`

For frontend development with hot reload, run `npm run dev`.

## Raspberry Pi and CI/CD

The repository includes GitHub Actions workflows that:

1. build and verify the application;
2. publish `linux/arm64` and `linux/amd64` images to GitHub Container Registry;
3. deploy successful builds through a self-hosted runner on the Raspberry Pi.

Follow the one-time setup and Codex handoff in
[docs/PI_DEPLOYMENT.md](docs/PI_DEPLOYMENT.md). Once deployed to the configured
Pi, the board is available at `http://192.168.10.201:8081/board`.

## Project structure

```text
src/main.ts          PixiJS board and game rules
src/controls.ts      Mobile controller UI
src/realtime.ts      WebSocket synchronization client
server.mjs           HTTP, WebSocket, and state persistence server
compose.yaml         Local source-build deployment
compose.pi.yaml      Published-image Raspberry Pi deployment
.github/workflows/   CI, container publishing, and Pi deployment
```
