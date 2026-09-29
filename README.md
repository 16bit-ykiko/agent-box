# agent-box

Lease a GitHub Actions runner and work on it over ssh — edit locally, build and test
remotely, keep the build directory warm for the whole lease.

```
box install owner/repo          # once per repo: locked `agent-box` branch with the workflow
id=$(box up owner/repo)         # ~30 s; prints the lease id
box push $id                    # HEAD + uncommitted changes to tracked files -> ~/src
box run $id 'cmake -B build -G Ninja && ninja -C build'
box ssh $id
box down $id
```

## What leaves this machine

- GitHub sees a per-lease ssh **public** key and a random lease id, nothing else. The repo
  holds no secrets; the workflow runs with `permissions: {}` and only for the owner.
- The runner generates its own host key and publishes it with a public quick-tunnel
  address; `box up` pins that key before connecting.
- With a Cloudflare token (`~/.config/cloudflare/token`, zone in
  `~/.config/agent-box/config.json`), `box up` then creates a tunnel for this lease only,
  hands its token to the runner inside the ssh session, moves to `box-<id>.<zone>` and
  closes the quick tunnel. `box down` deletes the tunnel and its DNS record.
- `box push` sends one commit: HEAD plus changes to tracked files. Untracked files never leave.
- Anything on the runner can use `sudo`; treat it as untrusted and never send credentials to it.

The `agent-box` branch must contain exactly `template/agent-box.yml` pinned to a commit on
this repo's main and be locked by the `agent-box` ruleset; `box up` checks both.
Local state (keys, ssh config, leases) is in `~/.local/state/agent-box`.
