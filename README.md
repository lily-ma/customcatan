# Catan Enhanced

A single-game Catan table with a PixiJS board, a mobile web controller, and a small WebSocket backend.

## Run with Docker

```sh
docker compose up --build
```

Then open:

- `http://<server-ip>:8080/board` on the shared display
- `http://<server-ip>:8080/controls` on one or more phones

Both routes use the same server and game state; no game ID is needed. The latest state is persisted in the `catan-data` Docker volume.

## Run without Docker

```sh
npm install
npm run build
npm start
```

The server listens on port `8080` by default. Set `PORT` and `DATA_DIR` to override the port and persistence directory.

## Raspberry Pi

Install Docker Engine and the Compose plugin on the Pi, copy or clone this repository, and run `docker compose up -d --build`. The image uses the official multi-architecture Node Alpine base and can build on 64-bit Raspberry Pi OS.
