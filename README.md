# agent-box

Lease a GitHub Actions runner and work on it over ssh — edit locally, build and test
remotely, keep the build directory warm for the whole lease.

```
box install owner/repo          # once per repo: locked `agent-box` branch with the workflow
id=$(box up owner/repo)         # ~1 min; prints the lease id
box push $id                    # working tree of tracked files -> ~/src
box run $id 'cmake -B build -G Ninja && ninja -C build'
box cp $id $other build/bin     # build/bin under ~/src, from one runner straight to the other
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
- **`box cp`** copies paths below `~/src` (or this checkout, `.`) as a tar, following
  symlinks on a box but not here, where no link on the way may lead out of the checkout. The
  receiver unpacks only the paths asked for, whatever the sender put in the stream, and this
  checkout takes only plain files and directories and never a `.git` or `.claude`, so a box
  can plant neither hooks nor links here. From one box to another the stream never touches
  this machine: the destination pulls it, zstd'd, over the source's tunnel, with a key it
  makes for this copy that the source accepts for one session, within ten minutes, for that
  tar only, and checks the source's host key pinned here. Nothing of this machine's goes to
  either box. With `.`, or `--via-here`, the tar comes through this machine, gzip'd.
- **`box run`** starts the command detached on the box and follows its output, reconnecting
  after a dropped tunnel; Ctrl-C or SIGTERM kills it on the box. stdout and stderr arrive
  merged. The output is untrusted: when it is not a terminal, escape sequences and control
  characters are stripped; on a terminal colours stay, but OSC (clipboard, title, links), DCS,
  APC, PM and SOS strings go. Everything else box prints from a box is stripped too, except
  in `box ssh`, which is a plain interactive terminal. Anything on the runner can `sudo`; never send credentials to it.

## Named tunnels (optional)

By default a box stays on its `trycloudflare.com` quick tunnel and no Cloudflare credential
is involved. With `{"zone": "<zone>"}` in `~/.config/agent-box/config.json` and a token in
`~/.config/agent-box/cloudflare-token` (Account › Cloudflare Tunnel › Edit, Zone › DNS ›
Edit on that zone only), `box up` moves each box to `box-<id>.<zone>` on a tunnel created
for that lease; `box down` rotates the tunnel secret and deletes the tunnel and its record.
Use a separate Cloudflare account whose only zone serves nothing else: the tunnel
permission covers every tunnel in the account, local agents can read the token, and whoever
runs code on the box can serve anything on its hostname until the tunnel is deleted.

## The agent-box branch

`box install` creates it from `template/agent-box.yml` and locks it to repo admins; later runs
only move the agent-box pin. Add the setup a box should start with before its last step,
usually the checkout, toolchain and cache restore steps of the repo's CI: `~/src` is
`$GITHUB_WORKSPACE`, so a restored compiler cache lands where CI keeps it and paths match.
Instructions for the agent go in `.github/agent-box/<os>.md`, `<linux|macos|windows>.md` or
`default.md` on the branch; `box up` prints the first that exists, read from GitHub, never from
the box. `box up` checks only that the branch is locked by a ruleset only admins can bypass,
keeps the dispatch inputs, grants no write permission and pins current runner code. What those steps do cannot reach this machine: a box is untrusted anyway. Rulesets
can only exempt roles, so every admin of the repo can change the branch.

Local state (keys, ssh config, leases) is in `~/.local/state/agent-box`.
