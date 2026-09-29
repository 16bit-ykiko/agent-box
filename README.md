# agent-box

Lease a GitHub Actions runner and work on it over ssh — edit locally, build and test
remotely, keep the build directory warm for the whole lease.

```
box install owner/repo          # once per repo: locked `agent-box` branch with the workflow
id=$(box up owner/repo)         # ~1 min; prints the lease id
box push $id                    # working tree of tracked files -> ~/src
box run $id 'cmake -B build -G Ninja && ninja -C build'
box ssh $id
box down $id
```

Public repos get 4 vCPU / 16 GB runners; private repos only 2 / 7. A box stops by itself
after 60 minutes without an ssh connection or at `--minutes` (default and max 340).

## What leaves this machine

- **GitHub** sees a per-lease ssh public key and a random lease id. The repo holds no
  secrets; the workflow runs with `permissions: {}` and only for the owner.
- **The runner** generates its own host key and publishes it with its quick-tunnel address
  in a public artifact; `box up` pins that key before connecting.
- **`box push`** sends one parentless commit whose tree is the working tree of tracked files
  (or `--ref`'s tree): no history, no untracked files unless `--untracked`. Files that are
  staged but not committed count as tracked and are sent; the files that differ from HEAD
  are listed. It refuses to push from a checkout without a GitHub remote for the leased repo.
- **`box run`** starts the command detached on the box and follows its output, reconnecting
  after a dropped tunnel; Ctrl-C or SIGTERM kills it on the box. stdout and stderr arrive
  merged. The output is untrusted: when it is not a terminal, escape sequences and control
  characters are stripped. Anything on the runner can `sudo`; never send credentials to it.

## Named tunnels (optional)

By default a box stays on its `trycloudflare.com` quick tunnel and no Cloudflare credential
is involved. With `{"zone": "<zone>"}` in `~/.config/agent-box/config.json` and a token in
`~/.config/agent-box/cloudflare-token` (Account › Cloudflare Tunnel › Edit, Zone › DNS ›
Edit on that zone only), `box up` moves each box to `box-<id>.<zone>` on a tunnel created
for that lease; `box down` rotates the tunnel secret and deletes the tunnel and its record.
Use a separate Cloudflare account whose only zone serves nothing else: the tunnel
permission covers every tunnel in the account, local agents can read the token, and whoever
runs code on the box can serve anything on its hostname until the tunnel is deleted.

## Trust

`box up` requires the `agent-box` branch to hold exactly `template/agent-box.yml`, pinned to
a commit on this repo's main with the current runner code, and to be locked by the
`agent-box` ruleset. Rulesets can only exempt roles, so every admin of the project repo can
still move that branch; `box up` would refuse the result, but it assumes you are the only admin.

Local state (keys, ssh config, leases) is in `~/.local/state/agent-box`.
