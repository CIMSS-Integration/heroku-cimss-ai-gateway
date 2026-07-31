# Production deployment plan — ai.themimit.com

Target: single EC2 instance, nginx-terminated TLS, Clerk production instance,
Salesforce **production** org for the Models API, secrets in AWS Secrets Manager.

Decisions taken: single instance + TLS (no ALB — keeps the 540s budget intact
with nothing new to tune); Models API on the production org; secrets in Secrets
Manager. **Domain cutover to `ai.themimit.com` is deferred by decision** — the
bare IP is the interim target, so Phase 3 is parked and Clerk stays on the dev
instance until TLS exists.

## Status — 2026-07-30

Live at `http://54.175.93.133`, serving **production Salesforce credentials**:

- `SF_LOGIN_URL` = `https://mimit.my.salesforce.com` (harvested from Heroku), with
  the sandbox values kept at `/opt/sfchat/.env.local.bak.20260730T072713` for
  rollback. Runtime-only vars, so the swap needed a restart, not a rebuild.
- Verified from the instance: client-credentials token issued by the production
  org, and **all six configured models returned 200**. The token being issued to
  this instance's IP also proves the Connected App has no IP restriction blocking
  it — the open question flagged before the swap.
- Clerk deliberately still `pk_test` (dev instance): `pk_live` requires https and
  a real domain, neither of which the bare IP has.

## What is still not production-grade

| Gap | Risk |
|---|---|
| No TLS; plain http on :80 | Credentials and chat content in clear text. Blocks Clerk `pk_live` |
| Clerk **dev** instance (`pk_test`) | Dev instances are intended for localhost, not shared traffic |
| **Production DB + production Salesforce, no TLS, dev auth** | See 0.6 — signed-in testing here writes real production chat history |
| Secrets in `/opt/sfchat/.env.local` on disk | Not audited, not rotatable, re-copied by hand each rebuild |
| SSH open to `0.0.0.0/0` | Whole internet can reach sshd |
| No IAM role on the instance | Blocks Secrets Manager and CloudWatch |
| No monitoring, alarms, or log retention | Failures are discovered by users, and journald is lost on terminate |
| Build happens in place | A failed build leaves no previous version to fall back to |
| 8 GB disk at 44%; `t2.xlarge` (burstable, prior gen) | Disk exhaustion during build; CPU-credit stalls under load |
| Local changes uncommitted; SSH key exposed in a transcript | No reproducible release; key must be rotated |

## Two invariants that must survive every future change

Both are load-bearing and both were discovered the hard way during this
deployment. They are documented at the point of use; repeated here because a
reviewer "cleaning up" either one takes production down.

1. **`-H localhost` in `sfchat.service` is not interchangeable with `-H 127.0.0.1`.**
   clerkMiddleware rewrites to the request's own absolute URL; Next 16 keeps that
   internal only when the target host matches the bound hostname, else it proxies
   to itself forever. Symptom: requests hang, journal shows
   `Failed to proxy http://localhost:3000/`.
2. **`HTTPS_REDIRECT=1` only once TLS actually terminates in front of the app.**
   Next synthesizes `x-forwarded-proto: http` for any non-TLS socket, so setting
   it while serving plain http redirects every request into a void.

Timeout contract to preserve: `proxy_read_timeout 600s` > `GENERATION_TIMEOUT_MS
540s` > the model call. The app must always lose the race to itself. **Do not put
CloudFront in front** — its origin-response timeout maxes at 180s and would break
long generations regardless of nginx.

---

## Phase 0 — Pre-flight (blocks everything; no production impact)

**The authoritative production config already exists as Heroku config vars on the
`cimss-ai-gateway` app**, and it has now been harvested. Most of this phase is
closed. What follows records the findings, because they change later phases.

### Findings (harvested 2026-07-30)

Heroku `cimss-ai-gateway` — stack `cnb` (Fir), region virginia, 1 web dyno at
`dyno-1c-0.5gb`, release **v52** running commit `af7fdf76`, which is the current
`master` HEAD. So production is running the same code the EC2 box was built from,
plus this migration's three uncommitted changes on the EC2 side only.

| Var | Heroku (production) | EC2 today | Action |
|---|---|---|---|
| `SF_LOGIN_URL` | `https://mimit.my.salesforce.com` — **production org** | `mimit--full.sandbox` | swap |
| `SF_CLIENT_ID` / `SF_CLIENT_SECRET` | present (85 / 64 chars) | sandbox values | swap |
| `SF_API_HOST` | unset → defaults to `api.salesforce.com` | same | none |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_live` | `pk_test` | swap (rebuild — inlined) |
| `CLERK_SECRET_KEY` | `sk_live` | `sk_test` | swap |
| `CLERK_PUBLISHABLE_KEY` | present (unprefixed duplicate) | present | carry over as-is |
| `DATABASE_URL` | `…cimss-prod…snowflake.app` | **identical host** | none — see 0.6 |
| `HTTPS_REDIRECT` | absent | absent | add `=1` at Phase 3.6 |

Consequences:

- **0.4 is closed.** Heroku already runs against the production Salesforce org, so
  there is no Connected App to create and no Salesforce critical path. The prod
  credentials simply move from Heroku config vars into Secrets Manager.
- **Model entitlement is effectively proven.** The six-model list
  (`config/models.ts`, commit `036a483`) is what release v52 is serving to real
  users against these exact credentials, so the list and the entitlement already
  agree in production.
- **DNS is a CNAME today, and cannot stay one.** Both custom domains are CNAMEs to
  `*.herokudns.com`; an Elastic IP requires an **A record**. Phase 3.5 is a
  record-type change, not a target edit.
- **`ai.cimss.com` is also live on Heroku** (CNAME → `lively-nomingia-…herokudns.com`,
  SNI `zuniceratops-76002`) alongside `ai.themimit.com` (→ `thermal-beet-…`,
  SNI `spinosaurus-76362`). Only `ai.themimit.com` was chosen for cutover, so
  Heroku cannot be decommissioned until `ai.cimss.com` is decided — see 7.4.

### Remaining Phase 0 items

- [x] **0.1 Harvest the Heroku config vars.** Done — table above.
- [x] **0.2 Diff Heroku against EC2.** Done — the "Action" column is the Phase 4
      cutover list: five values to swap, one to add, two already correct.
- [x] **0.3 Verify Models API entitlement for all six models.** Closed by
      production evidence (v52 serving this list on these credentials). Re-verify
      directly only if a model is added or the Connected App changes.
- [x] **0.4 Create a Connected App in the production org.** Not needed — Heroku is
      already on the production org.
- [ ] **0.5 Finish the Clerk production instance setup.** The `pk_live`/`sk_live`
      keys are in hand, and the SSO connection `oauth_custom_mimit_prod_sf` is
      confirmed in `lib/identity.ts:24-25`. Still to do: add `ai.themimit.com` to
      the instance's allowed origins, and confirm `clerk.*` DNS still resolves.
      This is the only Phase 0 credential work left.
- [ ] **0.6 Confirm history continuity — and contain the shared database.**
      Continuity is now near-certain: `DATABASE_URL` on Heroku and on the EC2 box
      resolve to the same `cimss-prod` host, and `sf_username` is the email from
      the Clerk SSO external account (already pointed at the production Salesforce
      org on both Clerk instances), so it does not change when the Models API org
      changes. Verify by signing one known user in and checking their
      `sf_username` matches rows already in the table.

      ⚠️ **The consequence cuts the other way too: the EC2 box is already wired to
      the production database.** Nothing has been written yet — every request
      during this deployment was anonymous and got a 401 — but the moment someone
      signs in on `54.175.93.133` to test, their chats land in production history,
      indistinguishable from real data. Before any human testing on that box,
      either point it at a non-production schema/database, or accept and announce
      that EC2 testing writes to production. Do not leave this implicit.
- [ ] **0.7 Confirm database posture.** The Snowflake-hosted Postgres is already
      `cimss-prod`. Confirm backup/retention policy and point-in-time recovery,
      and that the `ai` schema is not shared with something that could rewrite it.
- [ ] **0.8 Lower DNS TTL** on `ai.themimit.com` to 60s at least 24h before
      cutover, so the switch and any rollback both propagate fast.
- [ ] **0.9 Commit the working tree and tag.** `config/models.ts`, `proxy.ts`,
      `app/api/chat/route.ts`, and `deploy/` are uncommitted. Production must be
      deployable from a tagged commit, not from a laptop's working copy.
- [ ] **0.10 Rotate the SSH key.** The current private key was pasted into a chat
      transcript. Generate a new pair, install it, remove the old one from
      `~/.ssh/authorized_keys`.

## Phase 1 — Harden the instance (no production impact)

- [ ] **1.1 Attach an IAM instance role.** Least-privilege:
      `secretsmanager:GetSecretValue` on this app's secret only, plus
      `CloudWatchAgentServerPolicy`. Required by Phases 2 and 5.
- [ ] **1.2 Close SSH.** Restrict `sgr-0062ed58ffe55b6b5` / `sgr-02f1e6ca86a4ec7e1`
      (port 22, currently `0.0.0.0/0` and `::/0`) to your office/VPN range — or
      remove them entirely and use SSM Session Manager, since `amazon-ssm-agent`
      is already running and 1.1 gives it a role. Keep 80/443 open.
      Do **not** open 3000; the app binds loopback deliberately.
- [ ] **1.3 Grow the root volume** from 8 GB to 30 GB and extend the filesystem.
      `npm ci` + `next build` + two release directories (Phase 6) will not fit in
      4.5 GB of headroom.
- [ ] **1.4 Decide on instance type.** `t2.xlarge` is burstable and prior-gen; under
      sustained load it can stall on CPU credits. `t3a.xlarge` (cheaper, unlimited
      credits by default) or `m6i.xlarge` (no credit model) are better fits.
      Requires a stop/start — do it before the domain points here.
- [ ] **1.5 Enable unattended security updates** (`dnf-automatic`, security-only).
- [ ] **1.6 Confirm log rotation** covers `/var/log/nginx/sfchat.*.log`, and cap
      journald (`SystemMaxUse`) so logs cannot fill the disk.

## Phase 2 — Secrets to Secrets Manager

- [ ] **2.1 Create one secret**, e.g. `sfchat/prod`, holding `SF_LOGIN_URL`,
      `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `CLERK_SECRET_KEY`,
      `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `DATABASE_URL`, `HTTPS_REDIRECT`.
- [ ] **2.2 Render it at deploy time** into `/opt/sfchat/.env.local`, mode 600,
      owned by `ec2-user`. Keep the file as the delivery mechanism —
      `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` must exist at **build** time because Next
      inlines it into the client bundle, so a runtime-only fetch would ship a
      broken bundle. The file becomes a build artifact, not a hand-edited config.
- [ ] **2.3 Verify no secret is echoed** by the deploy script (no `set -x` around
      the render step) and that the rendered file is never included in a tarball.

## Phase 3 — Move `ai.themimit.com` from Heroku to EC2, with TLS

Decisions taken: pre-issue the certificate via **manual DNS-01** so there is no
unencrypted window, then convert renewal to HTTP-01; switch Clerk to `pk_live`
immediately after HTTPS is verified; leave `ai.cimss.com` on Heroku.

## As executed — 2026-07-30

**`ai.themimit.com` is live on EC2 over HTTPS.** The plan's ordering was not
followed, and the deviation is worth recording because it produced a real (brief)
exposure.

What happened: the DNS-01 TXT record never propagated, and the A record was
flipped while the certificate order was still pending. For a few minutes
`ai.themimit.com` therefore resolved to a box with **nothing on :443** (https
refused) and the app served over **plain http**. The plan's whole point — cert
first, so there is never an unencrypted window — was lost.

Recovery took the opposite path and was faster: because DNS now pointed at the
box, **HTTP-01 worked immediately** and needed no DNS action at all. The pending
DNS-01 order was abandoned, the cert issued via `--webroot` in about a minute,
and the TLS config applied.

Net effect on the original plan:

- **3.2 (manual DNS-01)** — abandoned. The `_acme-challenge.ai` TXT record is no
  longer needed and can be deleted from GoDaddy.
- **3.6 (convert renewal to HTTP-01)** — unnecessary. Issuance was HTTP-01 from
  the start, so `authenticator = webroot` was already correct and
  `certbot renew --dry-run` passes.
- **A real trap was found here:** certbot printed "Certbot has set up a scheduled
  task to automatically renew this certificate", but `certbot-renew.timer` was
  **installed and disabled**. Renewal would have silently never run and the cert
  would have expired on 2026-10-28. Now `enabled` and `active`. Do not trust
  certbot's success message on Amazon Linux — check the timer.

Verified after cutover:

| Check | Result |
|---|---|
| `https://ai.themimit.com/` | 200, chain valid |
| Certificate | `CN=ai.themimit.com`, issued 2026-07-30 10:36Z, expires 2026-10-28 (89 days) |
| `http://` | 301 → https (nginx, not the app) |
| Authoritative DNS at GoDaddy | `A → 54.175.93.133` only — no CNAME, no AAAA |
| `certbot renew --dry-run` | success |
| `certbot-renew.timer` | enabled + active |
| nginx | config == repo copy; `nginx -t` clean; survives a full restart |
| Build served | our EC2 build (`free-baboon-42`), not Heroku's |

**Not verified:** the 75s-request-over-TLS test. Static verification passed — the
:443 block includes the shared snippet, and the snippet carries
`proxy_read_timeout 600s` — and the same directive values were proven functionally
over http before TLS. But the end-to-end re-test through the TLS path was not
completed, because doing it means briefly repointing the live upstream. The honest
end-to-end proof is a real long prompt from a signed-in session; treat that as the
outstanding gate.

Two notes on the transition period:

- Stale caches kept some clients on Heroku for a while after the flip (a cached
  AAAA from the deleted CNAME). Heroku kept serving them correctly, so there was
  no outage — but during that window users got Heroku's **older** code depending
  on which resolver they used.
- A stray `next-server` from earlier debugging was found squatting on
  `127.0.0.1:3001`. Harmless (nothing proxies to it) but it should be killed; it
  also invalidated one timeout test by answering in place of a probe server.

### 3.7 completed — Clerk on the production instance

Switched from the dev instance (`free-baboon-42`, `pk_test`) to the production
instance (`clerk.themimit.com`, `pk_live`), keys taken from the Heroku config.
Rebuilt — required, since the publishable key is inlined into the client bundle —
and verified: the served HTML now references `clerk.themimit.com` with a `pk_live`
key, `free-baboon-42` is gone, `/` → 200, `/api/identity` → 401, zero errors in
the journal. Previous env saved at `.env.local.bak.20260730T115555`.

Switching instances invalidates sessions issued by the old one, so everyone signs
in again once.

**How to verify a production Clerk instance from the command line.** Worth
recording, because the obvious probe gives a false negative: a plain POST to
`/v1/client/sign_ins` is rejected with `"Redirect url mismatch"` for *every*
redirect target, including ones that are certainly valid. Production instances
validate the `Origin` header (dev instances don't), so the probe must send it:

```bash
curl -X POST "https://clerk.themimit.com/v1/client/sign_ins?_clerk_js_version=5" \
  -H "Origin: https://ai.themimit.com" -H "Referer: https://ai.themimit.com/" \
  --data-urlencode "strategy=oauth_custom_mimit_prod_sf" \
  --data-urlencode "redirect_url=https://ai.themimit.com/"
```

With the Origin header this returned an authorize URL at
`https://mimit.my.salesforce.com` — confirming both that `ai.themimit.com` is an
authorized origin and that it routes to the production Salesforce org.

**Finding worth acting on: `ai.cimss.com` is NOT an authorized origin on the
production Clerk instance.** The same probe with `Origin: https://ai.cimss.com`
returns `"Invalid HTTP Origin header"`. Since Heroku serves that hostname with
these same `pk_live` keys, sign-in there is likely broken already — a pre-existing
condition, not caused by this migration. Either add the origin in the Clerk
dashboard or confirm nobody uses that hostname.

Still outstanding: **3.8** (HSTS), deleting the ACME TXT record, and the IPv6
decision below.

### Starting state (verified 2026-07-30)

| | |
|---|---|
| `ai.themimit.com` | **CNAME** → `thermal-beet-mqsq1r2h8n2rwxce93jxchq4.bluebell-virginia.herokudns.com` |
| Serving now | Heroku, https 200, resolving to IPv6 `2600:1f18:…` |
| Heroku SNI endpoint | `spinosaurus-76362` (Heroku ACM manages today's cert) |
| DNS provider | GoDaddy (`ns31`/`ns32.domaincontrol.com`) — portal access confirmed |
| Target | A record → `54.175.93.133` (Elastic IP) |
| Box readiness | certbot 2.6.0 + `python3-certbot-nginx` available; nginx has ssl/http2/http3; **443 free** |
| Clerk prod | `clerk.themimit.com` → `frontend-api.clerk.services` resolves; `pk_live` keys in Heroku config |

**A CNAME cannot point at an IP.** This is a record-type change — delete the
CNAME, create an A record — not an edit of the existing target.

**Record the current CNAME target before touching anything.** It is the entire
rollback procedure, and it is not recoverable from the EC2 side.

### Two corrections to earlier guidance in this document

1. **Do NOT set `HTTPS_REDIRECT=1`.** nginx will own the http→https redirect for
   this host, which is the better layer for it. The app-level redirect in
   `proxy.ts` exists for platforms where the proxy isn't ours (Heroku). Enabling
   both adds nothing and introduces a trap: a request to the bare IP would be
   redirected to `https://54.175.93.133`, where the `ai.themimit.com` certificate
   does not match and the browser shows a security warning. Leave the flag unset.
2. **`certbot --manual` cannot auto-renew.** Step 3.6 is therefore mandatory, not
   optional cleanup. Skip it and the certificate expires silently in 90 days.

### 3.1 Pre-flight (no user impact)

- [ ] Record the existing CNAME target verbatim (rollback depends on it).
- [ ] Lower the TTL on the `ai.themimit.com` record. **GoDaddy's minimum is 600s
      (10 min)** — set that, and do it at least an hour ahead so the old TTL has
      expired everywhere before cutover.
- [ ] `sudo dnf install -y certbot python3-certbot-nginx`
- [ ] Confirm the `pk_live` Clerk instance lists `https://ai.themimit.com` in its
      allowed origins (it should — Heroku serves that host today).
- [ ] Confirm the Salesforce SSO Connected App has
      `https://clerk.themimit.com/v1/oauth_callback` registered. Also expected
      already, since Heroku uses `pk_live`.
- [ ] Decide the bare-IP behaviour after cutover (see 3.4). Testing does not need
      it — use `curl --resolve`.

### 3.2 Issue the certificate while DNS still points at Heroku

```bash
sudo certbot certonly --manual --preferred-challenges dns \
  -d ai.themimit.com --agree-tos -m <ops-email>
```

- [ ] Add the `_acme-challenge.ai.themimit.com` TXT record certbot prints, at
      GoDaddy.
- [ ] **Verify the TXT record has propagated before pressing Enter** —
      `dig +short TXT _acme-challenge.ai.themimit.com @8.8.8.8`. Answering too
      early fails the order and you must restart with a fresh token.
- [ ] Cert lands at `/etc/letsencrypt/live/ai.themimit.com/`.

Heroku keeps serving users throughout. Nothing about this step is visible to them.

### 3.3 Add the TLS server block and test it *before* any DNS change

This is the step that de-risks the whole cutover: with `--resolve` you can
exercise the real hostname, the real certificate, and the real app on the new box
while production traffic is still going to Heroku.

- [ ] Add a `server` block: `listen 443 ssl;` + `http2 on;`,
      `server_name ai.themimit.com;`, the cert paths from 3.2, and the same
      `location /` proxy body as `deploy/nginx-sfchat.conf`.
- [ ] **Re-assert the timeout contract inside the new block.**
      `proxy_read_timeout` / `proxy_send_timeout` are per-location and are **not**
      inherited from the existing `sfchat.conf` server block. Omit them and the
      600s budget silently reverts to nginx's 60s default, undoing the entire
      reason this app moved off Heroku. Same for `client_max_body_size 30m`.
- [ ] Add `location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }`
      on the :80 block, so 3.6 can switch renewals to HTTP-01.
- [ ] Add a :80 → 301 https redirect for `server_name ai.themimit.com`.
- [ ] `sudo nginx -t && sudo systemctl reload nginx`
- [ ] Validate without DNS:
      ```bash
      curl -sv --resolve ai.themimit.com:443:54.175.93.133 \
        https://ai.themimit.com/ -o /dev/null
      ```
      Expect 200, a valid certificate chain, and no hostname mismatch.
- [ ] Confirm the long-request path still works over TLS (the 75s slow-responder
      trick from `deploy/README.md`, via `--resolve`). Proves 3.3's timeouts.

### 3.4 Cut DNS at GoDaddy

- [ ] Delete the `ai.themimit.com` CNAME.
- [ ] Create `A ai.themimit.com → 54.175.93.133`, TTL 600.
- [ ] Watch propagation: `dig +short ai.themimit.com @8.8.8.8` until it returns
      the Elastic IP.
- [ ] Verify from outside: `curl -I https://ai.themimit.com/` → 200, and
      `http://ai.themimit.com/` → 301 to https.

HTTPS is live from the first resolved request, because 3.2 and 3.3 already ran.

### 3.5 Verify the app on the real hostname

- [ ] `/` returns 200 and renders; `/api/identity` returns 401 while signed out.
- [ ] Sign in through the **dev** Clerk instance (still `pk_test` at this point —
      it works over https as well as http, so nothing is broken mid-cutover).
- [ ] Send a long prompt to confirm the >30s path survives TLS end to end.

### 3.6 Convert renewal to HTTP-01 — mandatory

Now that DNS points here, HTTP-01 works and can run unattended.

```bash
sudo certbot --nginx -d ai.themimit.com --force-renewal
sudo certbot renew --dry-run
systemctl list-timers | grep certbot
```

- [ ] Confirm the renewal config no longer uses the `manual` authenticator
      (`/etc/letsencrypt/renewal/ai.themimit.com.conf`).
- [ ] Confirm the certbot systemd timer is enabled.

### 3.7 Switch Clerk to `pk_live`

- [ ] Copy `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_PUBLISHABLE_KEY`, and
      `CLERK_SECRET_KEY` from the Heroku config into `/opt/sfchat/.env.local`,
      keeping a timestamped backup.
- [ ] **Rebuild**, not just restart — the publishable key is inlined into the
      client bundle. Verify afterwards that the served HTML references
      `clerk.themimit.com` and no longer `free-baboon-42`.
- [ ] Sign in via Salesforce SSO; confirm the redirect goes to
      `mimit.my.salesforce.com`, that `/api/identity` returns the expected
      `sf_username`, and that **existing chat history appears** — the end-to-end
      proof that the identity key is unchanged (0.6).

### 3.8 Harden, once renewal is proven

- [ ] HSTS. Last, and only after 3.6 passes — it is hard to walk back.
- [ ] Modern cipher suite, OCSP stapling, and baseline security headers.

### Rollback

Single step, and it stays available as long as Heroku keeps the domain attached:

- [ ] Delete the A record, recreate the CNAME to the target recorded in 3.1.
- [ ] Propagation is bounded by the 600s TTL.
- [ ] **Do not remove `ai.themimit.com` from the Heroku app for at least a week.**
      Removing it also drops Heroku's ACM cert for that host, which turns a
      one-record rollback into a certificate re-issue under pressure.

### Risks specific to this cutover

| Risk | Mitigation |
|---|---|
| **IPv6 clients lose access.** Heroku answers on IPv6 today; this instance has no IPv6 address, so the A record is IPv4-only | Almost all clients are dual-stack, so accept it — or add an IPv6 CIDR to the VPC/subnet and an AAAA record. Decide before cutover, because it is invisible afterwards |
| Manual-DNS cert never renews | 3.6 is mandatory; `certbot renew --dry-run` is the gate |
| TLS block omits the 600s timeouts | Called out in 3.3, and the `--resolve` slow-request test in 3.3 catches it before users do |
| GoDaddy TTL floor is 600s | Rollback is ≤10 min, not instant. Cut over in a low-traffic window |
| Bare-IP access breaks | Expected: the cert only covers `ai.themimit.com`. Use `curl --resolve` for admin checks |
| **Heroku keeps serving `ai.cimss.com` on OLD code** | Per decision, `ai.cimss.com` stays. But Heroku is at commit `af7fdf76` and lacks every fix from this migration — 28s timeout, the under-counting token estimate, and the misleading PII error. Two deployments then write to one production database with different behaviour. Strongly consider redeploying current `master` to Heroku so both hosts behave the same |

## Phase 4 — Flip to production credentials

- [x] **4.1 Swap Clerk to `pk_live`/`sk_live`** — moved into **3.7**, because it is
      gated on TLS existing and belongs in the same window as the cutover.
- [x] **4.2 Swap `SF_LOGIN_URL` + client credentials** to the production org. **Done
      2026-07-30**: harvested from Heroku, verified by issuing a token and getting
      200 from all six models. Sandbox values kept at
      `/opt/sfchat/.env.local.bak.20260730T072713`.
      Note the side effect this exposed — the production org enforces a ~160k-token
      prompt cap via Trust Layer PII detection that the sandbox does not; see
      `PLATFORM_PROMPT_TOKEN_CAP` in `config/models.ts`.
- [ ] **4.3 Smoke test on the real hostname:** sign in via Salesforce SSO; confirm
      `/api/identity` returns the expected `sf_username`; confirm prior chat
      history is visible (validates 0.6); send a short prompt on each model; send
      one deliberately long prompt to confirm the >30s path still works over TLS;
      upload a `.pdf` and a `.docx` to exercise `/api/attach` through the 30 MB
      body limit.
- [ ] **4.4 Confirm the persistence banner stays hidden** — the UI shows an amber
      "not being saved" warning when `/api/chat` returns `persisted: false`. Its
      absence is the end-to-end proof that DB writes work under prod credentials.

## Phase 5 — Observability and backups

- [ ] **5.1 Ship logs to CloudWatch** — journald `sfchat` unit and the nginx
      `sfchat.*.log` files, with a retention period set.
- [ ] **5.2 Add a health endpoint.** There is no cheap unauthenticated health check
      today: `/` renders the app and `/api/identity` returns 401. Add a tiny
      `/api/health` that checks DB connectivity, for alarms and for the Phase 6
      deploy gate.
- [ ] **5.3 Alarms:** instance status check failed; CPU credit balance low (if
      staying on `t2`); disk > 80%; memory > 85%; nginx 5xx rate; and an external
      uptime check on `https://ai.themimit.com/api/health` — that last one is what
      actually catches "the site is down".
- [ ] **5.4 Alert on the failure modes we hit.** Log-metric filters for
      `Failed to proxy` (the self-proxy loop) and for `[/api/chat] model call
      timed out` (timeout budget exhausted). These two cover the specific ways
      this app has actually broken.
- [ ] **5.5 Cost/abuse guard.** Every request spends Models API tokens. Add nginx
      `limit_req` on `/api/chat`, and alarm on request volume. Usage is already
      logged per generation in `/api/chat` — turn that into a metric.
- [ ] **5.6 Back up what isn't reproducible:** the Secrets Manager secret and the
      `ai` schema (per 0.7). The instance itself should be reproducible from the
      repo — take one AMI after Phase 3 as a known-good baseline.

## Phase 6 — Deploy process and rollback

Current process builds in place, so a failed build leaves nothing to fall back to
and the app is down while it runs.

- [ ] **6.1 Release directories + symlink.** Build into
      `/opt/sfchat/releases/<git-sha>/`, then atomically repoint
      `/opt/sfchat/current` and restart. Restart becomes seconds, not minutes.
- [ ] **6.2 Gate the switch on a health check** — build, start on a scratch port,
      poll `/api/health`, and only then flip the symlink.
- [ ] **6.3 Keep the last 3 releases** so rollback is a symlink flip plus restart.
- [ ] **6.4 Deploy from a tagged commit**, not a local working tree (depends on 0.9).
- [ ] **6.5 Write the rollback runbook**: previous release, previous secret version,
      DNS back to Heroku while its dynos still exist.

## Phase 7 — Cutover and decommission

- [ ] **7.1 Pick a low-traffic window.** Expect a few seconds of restart downtime
      plus DNS propagation (fast, given 0.8).
- [ ] **7.2 Keep Heroku running and warm** for at least a week. `Procfile` and
      `project.toml` are untouched, so it remains a working fallback — the only
      rollback that survives a total instance loss.
- [ ] **7.3 Watch for a full day**: 5xx rate, timeout log lines, DB write failures,
      token spend versus the previous baseline.
- [ ] **7.4 Decommission Heroku** only after a clean week, and only once an AMI
      plus a rehearsed rebuild exist. Then remove `Procfile`/`project.toml` and
      the Heroku references still in `README.md`.

---

## Risks worth naming

| Risk | Likelihood | Mitigation |
|---|---|---|
| A model from `config/models.ts` isn't entitled in the prod org | Medium | 0.1 + 0.3 catch it before cutover; prune the list |
| Single instance dies | Low, high impact | AMI baseline (5.6) + Heroku fallback (7.2). Accepted tradeoff of the single-instance choice |
| TLS block omits the long timeouts | Medium | 3.3 is a standalone step for exactly this |
| A future edit "fixes" `-H localhost` | Medium | Documented in the unit file, `deploy/README.md`, and here |
| Clerk prod SSO slug differs again | Low | `isSalesforceProvider` already accepts both forms |
| Sandbox refresh (if 0.4 slips) | High if unaddressed | The reason the Models API moves to prod at all |
| Disk fills during build | Medium | 1.3 before Phase 6 introduces multiple release dirs |

## Suggested sequencing

Phase 0 and Phase 1 run in parallel and touch nothing live. Phase 2 depends on
1.1. Phase 3 is the first change users can see and should be its own window.
Phase 4 follows immediately in the same window. Phases 5–6 can land after
cutover, but **5.2 (health endpoint)** is worth pulling forward since 6.2 needs
it. Phase 7 closes out a week later.

Critical path: `0.1 → 0.3 → 0.4` (Salesforce prod access) and `3.1 → 3.5 → 3.6 → 4.1`
(TLS before Clerk prod). Everything else is parallelizable.
