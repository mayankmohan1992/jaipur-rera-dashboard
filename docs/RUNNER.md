# Running the refresh without a laptop

The portal only answers to ordinary internet addresses. Every GitHub-hosted runner is
Azure, and Azure cannot open a TCP connection to any of the three portal hosts. Measured
22 Nov 2026 from `westus2`, runner IP `4.242.53.74`:

```
rera.rajasthan.gov.in      -> 103.203.139.246   connect 0.000s  timeout after 20s
reraapi.rajasthan.gov.in   -> 103.203.139.246   connect 0.000s  timeout after 20s
reraapp.rajasthan.gov.in   -> 103.203.139.252   connect 0.000s  timeout after 20s
```

DNS resolves, packets vanish. That is a policy at the portal end, not a bug here, and no
workflow file can route around it. So the refresh has to run somewhere the portal will
talk to. Two ways to get there.

## Option A — a runner you own (recommended, free)

Any always-on machine with normal internet: a ₹0 Raspberry Pi, a NAS, a mini-PC, or a
VPS. It does not have to be in India — consumer egress in the US and EU reaches the
portal fine; it is *datacentre* ranges that get dropped, so test a VPS before paying for
one:

```bash
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' --max-time 20 \
  https://reraapi.rajasthan.gov.in/api/web/Home/GetVisitorCount
# 401 in under a second = reachable (401 is the expected no-key answer)
# 000 after 20 s      = blocked, try a different provider
```

Register the machine once:

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -fsSL -o runner.tar.gz https://github.com/actions/runner/releases/latest/download/actions-runner-linux-x64.tar.gz
tar xzf runner.tar.gz
./config.sh --url https://github.com/mayankmohan1992/jaipur-rera-dashboard \
            --token <TOKEN> --labels rera --unattended
sudo ./svc.sh install && sudo ./svc.sh start     # survives reboots and logouts
```

Get `<TOKEN>` from **Settings → Actions → Runners → New self-hosted runner**. The label
`rera` is what `.github/workflows/refresh-selfhosted.yml` targets. That workflow is
**dispatch-only** while no runner exists — a scheduled job with no runner to claim it sits
`queued` for ever and looks like a hang, so the cron is kept commented out in the file. Once
the runner shows **Idle**, do two things:

```bash
# 1. uncomment the two lines under `on:` in .github/workflows/refresh-selfhosted.yml
#      schedule:
#        - cron: '30 0 * * *'        # 06:00 IST
# 2. drop the timer on this machine — the Action owns the daily refresh from now on
systemctl --user disable --now jaipur-rera-refresh.timer
```

Until then the GitHub-hosted workflow (`refresh.yml`) still runs daily: it probes the portal,
and because Azure egress is blocked it exits green with the reason in the run summary. That is
a reachability report, not a refresh — no data is published from it.

Keep the working directory warm — `raw/` and `raw_qpr/` live in the runner's workspace
and make each run incremental instead of a full crawl.

## Option B — route the Action through a proxy (no machine of your own)

`urllib` honours `HTTPS_PROXY`, so a proxy is enough:

```yaml
env:
  HTTPS_PROXY: ${{ secrets.RERA_PROXY_URL }}   # http://user:pass@host:port
```

What works: a residential proxy, or a VPN/tunnel with residential or Indian egress.
What does not: Cloudflare Workers, other serverless relays, and ordinary cloud proxies —
they egress from datacentre ranges and hit the same wall (a relay test returned Cloudflare
522 against the portal). Expect ₹400–1,500/month for a residential proxy with enough
bandwidth for a 53 MB payload plus 18k calls, and expect the provider's IPs to be shared
and occasionally blocked.

Either way, add `RERA_PROXY_URL` as a repository secret and switch
`.github/workflows/refresh-selfhosted.yml` to `runs-on: ubuntu-latest` with that env —
or leave it self-hosted and set the proxy there instead.

## What happens when nothing can reach the portal

The site does not lie about it. If `meta.json` is more than three days old, the page
shows a red notice under the tab strip naming the age and the date of the last figures,
and `verify.py` refuses to publish a payload whose QPR cache is incomplete. Stale data
with a warning is acceptable; stale data pretending to be current is not.
