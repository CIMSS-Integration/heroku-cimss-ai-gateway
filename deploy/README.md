# EC2 deployment

Why this exists: Heroku's router caps a request at 30s (H12), which killed long
Models API generations. On EC2 the ceiling is ours to set — see
[nginx-sfchat.conf](nginx-sfchat.conf) and `GENERATION_TIMEOUT_MS` in
`config/models.ts`. Verified: a 75s request returns 200 end to end.

## Layout

```
internet :80 ──▶ nginx (conf.d/sfchat.conf) ──▶ localhost:3000 (systemd: sfchat)
```

| Thing | Where |
|---|---|
| Instance | `i-023c4bb9e266b3ba0`, Amazon Linux 2023, `us-east-1` |
| Address | `54.175.93.133` (Elastic IP, stable across reboots) |
| App root | `/opt/sfchat` (owned by `ec2-user`) |
| Secrets | `/opt/sfchat/.env.local`, mode `600` |
| Salesforce org | **production** (`mimit.my.salesforce.com`) as of 2026-07-30; sandbox values kept in `.env.local.bak.20260730T072713` |
| Clerk | **dev** instance `free-baboon-42.clerk.accounts.dev` (`pk_test`) — intentional; `pk_live` needs https + a real domain |
| Unit | `/etc/systemd/system/sfchat.service` |
| nginx | `/etc/nginx/conf.d/sfchat.conf` |
| Logs | `journalctl -u sfchat -f`, `/var/log/nginx/sfchat.*.log` |

Both `sfchat` and `nginx` are `enabled`, so the app comes back after a reboot.

## Redeploy

From the repo root, with `$KEY` pointing at the instance key:

```bash
tar czf - --exclude=./node_modules --exclude=./.next --exclude=./.git \
  --exclude=./docs --exclude='*.pdf' --exclude='*.tsbuildinfo' . \
  | ssh -i "$KEY" ec2-user@54.175.93.133 'tar xzf - -C /opt/sfchat'

ssh -i "$KEY" ec2-user@54.175.93.133 \
  'cd /opt/sfchat && npm ci --no-audit && npm run build && sudo systemctl restart sfchat'
```

`npm ci` is only needed when `package-lock.json` changed. If the unit or nginx
file changed, copy it into place and `sudo systemctl daemon-reload` /
`sudo nginx -t && sudo systemctl reload nginx`.

## Two things that will bite you

Both are documented at length in the files themselves; the short version:

1. **`-H localhost` in the unit file is not interchangeable with `-H 127.0.0.1`.**
   clerkMiddleware rewrites to the request's own absolute URL
   (`http://localhost:3000/`); Next 16 only keeps such a rewrite internal when the
   target host matches the bound hostname, otherwise it proxies to itself in an
   infinite loop. Symptom: requests hang forever, journal shows
   `Failed to proxy http://localhost:3000/`.

2. **Do not set `HTTPS_REDIRECT=1` while serving plain http.** Next synthesizes
   `x-forwarded-proto: http` for any non-TLS socket, so the redirect in `proxy.ts`
   would fire on every request and send it to an https URL nothing is listening on.

3. **There are three Clerk instances, and their names do not indicate their
   environment.** `noted-pegasus-87` has a connection displayed as "Salesforce
   MIMIT Prod" whose discovery endpoint is a *sandbox*; `free-baboon-42` (dev, app
   "CIMSSAIGateway") is the one genuinely wired to `mimit.my.salesforce.com` and is
   what this box uses; `clerk.themimit.com` is the `pk_live` instance Heroku uses.
   If a login lands on the wrong Salesforce org, decode the publishable key
   (`base64 -d` the part after `pk_test_`) to see which instance the build is
   actually talking to before touching any dashboard. Changing instance also means
   registering that instance's `/v1/oauth_callback` in the Salesforce Connected App.

4. **This box writes to the production database.** `DATABASE_URL` here is the same
   `cimss-prod` Postgres that the Heroku app uses, and since 2026-07-30 the
   Salesforce credentials are production too. Anyone who signs in and chats
   creates real production rows in `ai.chat_session` / `ai.chat_message` —
   indistinguishable from traffic on `ai.themimit.com`. Point `DATABASE_URL` at a
   separate schema first if you want throwaway testing.

## Adding TLS

Port 443 is already open in `sg-088f3a41bc232212f`, and there is a public DNS name
(`ec2-54-175-93-133.compute-1.amazonaws.com`). Certbot needs a real domain, so
point one at `54.175.93.133` first, then:

```bash
sudo dnf install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain
```

Then set `HTTPS_REDIRECT=1` in `/opt/sfchat/.env.local` and restart `sfchat`.

Clerk is currently a **development** instance (`pk_test`), which is why it works
on a bare IP over http. Moving to a `pk_live` instance requires a real domain and
HTTPS — do the TLS step first.
