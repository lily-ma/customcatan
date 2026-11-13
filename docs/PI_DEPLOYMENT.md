# Raspberry Pi deployment

GitHub Actions builds and publishes `linux/arm64` and `linux/amd64` images to
GitHub Container Registry. A self-hosted GitHub Actions runner on the Pi deploys
the latest successful `master` or `main` build.

## One-time Pi setup

The Pi should run 64-bit Raspberry Pi OS and have Docker Engine, the Docker
Compose plugin, Git, and a GitHub Actions runner installed. The runner must:

- belong to this repository;
- run as a dedicated, non-root user that can use Docker;
- have the custom label `catan-pi`; and
- be installed as a system service so it survives reboots.

In GitHub, open **Settings → Actions → Runners → New self-hosted runner**, select
Linux and ARM64, then follow the generated commands on the Pi. Add `catan-pi`
when the configuration asks for extra labels. The registration token shown by
GitHub is short-lived and should not be committed or pasted into project files.

Before enabling automatic deployment, create an environment named
`raspberry-pi` under **Settings → Environments**. Optional deployment approvals
can be configured there.

The runner account needs Docker access. After adding it to the `docker` group,
start a new login session before testing `docker version` and
`docker compose version`.

## Deployment flow

1. A push or pull request runs `.github/workflows/ci.yml`.
2. A push to `master` or `main` publishes the multi-architecture image.
3. A successful publish triggers the Pi runner.
4. The Pi pulls the image, recreates the service, and waits for its health check.

Game state is kept in the named Docker volume `catan-data`, so deployments do
not reset an in-progress game.

Once deployed, use:

- `http://192.168.10.201:8080/board`
- `http://192.168.10.201:8080/controls`

## Prompt for Codex on the Pi

Use this prompt after creating the GitHub repository and pushing this project:

> Set up this Raspberry Pi as the self-hosted GitHub Actions deployment runner
> for `lily-ma/customcatan`. Follow `docs/PI_DEPLOYMENT.md`. Install any missing
> Docker/Git prerequisites, register an ARM64 repository runner with the label
> `catan-pi`, install it as a service, verify the runner user can run Docker, then
> manually run the `Deploy to Raspberry Pi` workflow and confirm the health API
> at `http://127.0.0.1:8080/api/health`. Ask me to supply the short-lived runner
> registration token when GitHub generates it; do not store that token in files.

## Rollback

Published revisions also receive an immutable `sha-<commit>` tag. To roll back,
set `CATAN_IMAGE` to that tag and run:

```sh
CATAN_IMAGE=ghcr.io/lily-ma/customcatan:sha-0123456 \
  docker compose -f compose.pi.yaml up -d --pull always --wait
```
