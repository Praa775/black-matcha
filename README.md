# BLACK MATCHA Remote Control — Green Edition

Starter project: green-themed admin dashboard, HTTPS URL config, basic server reachability checks, local scheduled JSON backups, and a simple user list.

## Run locally or on Pterodactyl

1. Upload the project files to a Node.js server.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Set strong unique `ADMIN_PASSWORD` and `SESSION_SECRET` values.
5. Set the server startup command to `npm start`.
6. Open `https://your-domain/` (use HTTPS through a reverse proxy or hosting platform).

## Important limitations

- `config.json` is the runtime source of truth in this starter. The optional `GITHUB_CONFIG_URL` is reserved for future integration and is not automatically synced by this version.
- To host the config directly in GitHub for APKs, publish a public `config.json` and use its **raw.githubusercontent.com** URL in the APK's remote-config loader. A private repository requires a server-side token; never embed a GitHub token in the APK or HTML.
- Monitoring checks `HEAD` requests against the configured HTTPS URLs. Some hosts block `HEAD`; this only tests basic reachability and is not a complete application health check. Prefer a dedicated `/health` endpoint and monitor it explicitly.
- Failover selection is exposed in `/api/overview` and `/api/public-config`. This does not magically reroute an existing APK unless the APK reads `/api/public-config` (or your GitHub config) and uses the returned URL. WebViews may need to reload the URL.
- Backups are local JSON snapshots under `backups/`, limited to 30. They are not off-site backups. For resilience, copy backups to a separate storage provider or a private GitHub repository using a server-side token. Do not commit user data or secrets to a public repository.
- `users.json` is demo/manual data. It does not discover actual app users automatically. Connect your real login/database system before relying on the user list.
- Authentication is a minimal starter and stores sessions in process memory. Add rate limiting, HTTPS, persistent sessions, audit logging, and stronger production security before exposing publicly.
- No passwords, tokens, private keys, or sensitive personal data should be placed in a public repository.

## Files

- `server.js`: Express API, monitoring loop, login, config updates, user list, scheduled backups.
- `public/index.html`: dashboard UI.
- `config.json`: active remote config.
- `users.json`: demo users.
- `.env.example`: environment variables.
