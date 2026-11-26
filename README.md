# Delb

Delb is a self-hosted ebook library for your household or a small group. Catalog
your books, read EPUBs and PDFs in your browser, and keep your reading progress,
notes, and shelves private.

![The Delb dashboard in dark mode, showing a wall of book covers, reading status counts, and progress bars for books in progress](docs/images/readme-hero.png)

## Hosting

### Docker

For an install on your own machine, run this command with Docker and OpenSSL
installed. Keep the generated secret for future container replacements.

```sh
DELB_AUTH_SECRET="$(openssl rand -hex 32)"
docker run -d \
  --name delb \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e BETTER_AUTH_SECRET="$DELB_AUTH_SECRET" \
  -e BETTER_AUTH_URL=http://localhost:3000 \
  -v delb-data:/app/data \
  -v delb-library:/app/library \
  ghcr.io/lancewilhelm/delb:stable
```

Open `http://localhost:3000` and register the first account, which becomes the
Owner. The two named volumes keep your database and books between container
replacements.

### Unraid

In the Unraid web UI, open **Docker → Add Container**. This example uses a pool
named `cache` and an Unraid server at `192.168.1.20`. Use your own pool name and
server IP.

| Field                         | Example value                                                      |
| ----------------------------- | ------------------------------------------------------------------ |
| Name                          | `delb`                                                             |
| Repository                    | `ghcr.io/lancewilhelm/delb:stable`                                 |
| Network Type                  | Bridge                                                             |
| Port (TCP)                    | Host `3080` to container `3000`                                    |
| Path (Read/Write)             | Host `/mnt/cache/appdata/delb/data` to container `/app/data`       |
| Path (Read/Write)             | Host `/mnt/cache/appdata/delb/library` to container `/app/library` |
| Variable `BETTER_AUTH_SECRET` | Output of `openssl rand -hex 32`. Keep the same value on updates.  |
| Variable `BETTER_AUTH_URL`    | `http://192.168.1.20:3080`                                         |

Create both host folders and make them writable by UID/GID `1001:1001`.
If they are already writable by `99:100`, you can set `--user 99:100`
in **Advanced View → Extra Parameters**. Create the container, open the URL
you set above, and register the Owner account.

See the [Docker hosting guide](docs/hosting/docker.md) for Compose, permissions,
and optional mounts.

## Documentation

- [Use Delb](docs/README.md#use-delb) to add books, manage access, or connect an agent.
- [Host Delb](docs/hosting/README.md) for configuration, backups, and upgrades.
- [Contribute](CONTRIBUTING.md) to run Delb locally and submit changes.
- [Release notes](https://github.com/lancewilhelm/delb/releases) for changes in each version.

[MIT License](LICENSE)
