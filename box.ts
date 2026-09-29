#!/usr/bin/env node
// box — lease a GitHub Actions runner and work on it over ssh.
// Secrets stay on this machine: GitHub only ever sees a public key, the runner only ever
// receives a tunnel token that is deleted with the lease.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACTION = "16bit-ykiko/agent-box";
const BRANCH = "agent-box";
const WORKFLOW = ".github/workflows/agent-box.yml";
const HOME = os.homedir();
const STATE = path.join(process.env.XDG_STATE_HOME ?? path.join(HOME, ".local/state"), "agent-box");
const CLOUDFLARED = { version: "2026.9.3", sha256: "77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2" };

type Config = { owner: string; zone?: string; cloudflareTokenFile: string };
type Lease = {
  id: string;
  repo: string;
  created: string;
  runId?: number;
  host?: string;
  named?: { tunnelId: string; dnsId: string; accountId: string; zoneId: string };
};

const log = (msg: string) => process.stderr.write(`box: ${msg}\n`);
function die(msg: string): never {
  log(msg);
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// `zone` turns on named tunnels. Use a zone that serves nothing else: whoever runs code on
// the box can serve anything on box-<id>.<zone> until the tunnel is deleted.
function config(): Config {
  const file = path.join(HOME, ".config/agent-box/config.json");
  const c = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Config>) : {};
  return {
    owner: c.owner ?? gh(["api", "user", "--jq", ".login"]).trim(),
    zone: c.zone,
    cloudflareTokenFile: (c.cloudflareTokenFile ?? "~/.config/agent-box/cloudflare-token").replace(/^~/, HOME),
  };
}

function ensureState() {
  for (const dir of [STATE, path.join(STATE, "bin"), path.join(STATE, "leases")]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
}

// The GitHub API is flaky from behind the proxy; retry everything but real HTTP errors.
function gh(args: string[]): string {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const stderr = String((e as { stderr?: unknown }).stderr ?? "");
      if (attempt >= 4 || /HTTP 4\d\d/.test(stderr)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * attempt);
    }
  }
}
const isNotFound = (e: unknown) => /HTTP 404/.test(String((e as { stderr?: unknown }).stderr ?? ""));
function ghJson<T>(api: string): T {
  return JSON.parse(gh(["api", api])) as T;
}

// ---------------------------------------------------------------- leases

const leaseDir = (id: string) => path.join(STATE, "leases", id);
const sshConfig = (id: string) => path.join(leaseDir(id), "ssh_config");

function saveLease(l: Lease) {
  fs.writeFileSync(path.join(leaseDir(l.id), "lease.json"), JSON.stringify(l, null, 2) + "\n", { mode: 0o600 });
}
function loadLease(id: string | undefined): Lease {
  if (!id || !/^[0-9a-f]{10}$/.test(id)) die(`expected a lease id, got ${id ?? "nothing"} (see \`box ls\`)`);
  const file = path.join(leaseDir(id), "lease.json");
  if (!fs.existsSync(file)) die(`no lease ${id}`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as Lease;
}
function allLeases(): Lease[] {
  const dir = path.join(STATE, "leases");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((id) => fs.existsSync(path.join(dir, id, "lease.json")))
    .map((id) => loadLease(id));
}

// ---------------------------------------------------------------- ssh

function writeSshConfig(l: Lease, host: string, user: string) {
  const dir = leaseDir(l.id);
  const lines = [
    "Host box",
    `  HostName ${host}`,
    `  HostKeyAlias agent-box-${l.id}`,
    `  User ${user}`,
    `  IdentityFile ${dir}/id_ed25519`,
    "  IdentitiesOnly yes",
    "  IdentityAgent none",
    "  StrictHostKeyChecking yes",
    `  UserKnownHostsFile ${dir}/known_hosts`,
    "  GlobalKnownHostsFile /dev/null",
    "  UpdateHostKeys no",
    "  ForwardAgent no",
    "  ForwardX11 no",
    "  ClearAllForwardings yes",
    "  PermitLocalCommand no",
    "  BatchMode yes",
    "  LogLevel ERROR",
    `  ProxyCommand /usr/bin/env -i HOME=${dir} PATH=/usr/bin:/bin ${cloudflaredPath()} access ssh --hostname %h`,
    "  ControlMaster auto",
    `  ControlPath ${dir}/cm`,
    "  ControlPersist 10m",
    "  ServerAliveInterval 30",
    "  ServerAliveCountMax 4",
  ];
  fs.writeFileSync(sshConfig(l.id), lines.join("\n") + "\n", { mode: 0o600 });
}

function ssh(l: Lease, command: string, opts: { input?: string; timeout?: number; tty?: boolean } = {}) {
  const args = ["-F", sshConfig(l.id), ...(opts.tty ? ["-t"] : []), "box", command];
  return spawnSync("ssh", args, {
    input: opts.input,
    stdio: opts.input === undefined && opts.timeout === undefined ? "inherit" : ["pipe", "pipe", "pipe"],
    timeout: opts.timeout,
    encoding: "utf8",
  });
}

async function waitForSsh(l: Lease, seconds: number) {
  for (let i = 0; i < seconds / 3; i++) {
    const r = ssh(l, "true", { timeout: 20_000 });
    if (r.status === 0) return;
    await sleep(3000);
  }
  throw new Error(`cannot ssh into ${l.id}`);
}

function closeMaster(l: Lease) {
  spawnSync("ssh", ["-F", sshConfig(l.id), "-O", "exit", "box"], { stdio: "ignore" });
}

// ---------------------------------------------------------------- cloudflared (local)

function cloudflaredPath() {
  return path.join(STATE, "bin", `cloudflared-${CLOUDFLARED.version}`);
}

async function ensureCloudflared() {
  const file = cloudflaredPath();
  if (fs.existsSync(file)) return;
  if (process.platform !== "linux" || process.arch !== "x64") die("box runs on x86_64 Linux only");
  log(`downloading cloudflared ${CLOUDFLARED.version}`);
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED.version}/cloudflared-linux-amd64`;
  const res = await fetch(url);
  if (!res.ok) die(`download failed: ${res.status} ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== CLOUDFLARED.sha256) die("cloudflared checksum mismatch");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes, { mode: 0o700, flag: "wx" });
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- cloudflare api

function cloudflareToken(c: Config): string | undefined {
  return c.zone && fs.existsSync(c.cloudflareTokenFile) ? fs.readFileSync(c.cloudflareTokenFile, "utf8").trim() : undefined;
}

async function cf<T>(token: string, api: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${api}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { success: boolean; errors: unknown; result: T };
  if (!json.success) throw new Error(`cloudflare ${method} ${api.split("?")[0]}: ${JSON.stringify(json.errors)}`);
  return json.result;
}

async function zoneOf(token: string, zone: string) {
  const [z] = await cf<{ id: string; account: { id: string } }[]>(token, `/zones?name=${zone}`);
  if (!z) throw new Error(`zone ${zone} not found`);
  return { zoneId: z.id, accountId: z.account.id };
}

// Rotating the secret first revokes the token the runner holds, so a copied token can
// neither keep a connector up nor block the deletion.
async function deleteTunnel(token: string, accountId: string, tunnelId: string) {
  const t = `/accounts/${accountId}/cfd_tunnel/${tunnelId}`;
  await cf(token, t, "PATCH", { tunnel_secret: randomBytes(32).toString("base64") });
  for (let i = 0; ; i++) {
    await cf(token, `${t}/connections`, "DELETE").catch(() => {});
    try {
      return await cf(token, t, "DELETE");
    } catch (e) {
      if (i >= 10) throw e;
      await sleep(3000);
    }
  }
}

async function deleteNamed(token: string, named: NonNullable<Lease["named"]>) {
  await deleteTunnel(token, named.accountId, named.tunnelId);
  if (named.dnsId)
    await cf(token, `/zones/${named.zoneId}/dns_records/${named.dnsId}`, "DELETE").catch((e: Error) => {
      if (!/"code":81044/.test(e.message)) throw e;
    });
}

// Move the box from its public quick tunnel to a tunnel of our own. The token travels
// inside the ssh session only and dies with the lease.
async function upgradeToNamed(l: Lease, c: Config, token: string, user: string) {
  const { zoneId, accountId } = await zoneOf(token, c.zone!);
  const host = `box-${l.id}.${c.zone}`;
  const tunnel = await cf<{ id: string }>(token, `/accounts/${accountId}/cfd_tunnel`, "POST", {
    name: `agent-box-${l.id}`,
    config_src: "cloudflare",
  });
  l.named = { tunnelId: tunnel.id, dnsId: "", accountId, zoneId };
  saveLease(l);
  await cf(token, `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, "PUT", {
    config: { ingress: [{ hostname: host, service: "ssh://127.0.0.1:2222" }, { service: "http_status:404" }] },
  });
  const dns = await cf<{ id: string }>(token, `/zones/${zoneId}/dns_records`, "POST", {
    type: "CNAME",
    name: host,
    content: `${tunnel.id}.cfargotunnel.com`,
    proxied: true,
    comment: `agent-box ${l.id} ${l.repo}`,
  });
  l.named.dnsId = dns.id;
  saveLease(l);
  const tunnelToken = await cf<string>(token, `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`);

  const start = [
    "set -e; umask 077; t=$(cat)",
    'TUNNEL_TOKEN="$t" setsid nohup ~/.box/cloudflared tunnel --no-autoupdate run > ~/.box/named.log 2>&1 < /dev/null &',
    "echo $! > ~/.box/named.pid",
    "for i in $(seq 60); do grep -q 'Registered tunnel connection' ~/.box/named.log && exit 0; sleep 1; done; exit 1",
  ].join("\n");
  const r = ssh(l, start, { input: tunnelToken, timeout: 90_000 });
  if (r.status !== 0) throw new Error("named tunnel did not come up on the runner");

  closeMaster(l);
  writeSshConfig(l, host, user);
  await waitForSsh(l, 60);
  l.host = host;
  saveLease(l);
  ssh(l, "kill $(cat ~/.box/quick.pid) 2>/dev/null; true", { timeout: 20_000 });
}

// ---------------------------------------------------------------- workflow on the repo

function renderWorkflow(owner: string, sha: string) {
  return fs
    .readFileSync(path.join(HERE, "template/agent-box.yml"), "utf8")
    .replaceAll("@OWNER@", owner)
    .replaceAll("@ACTION@", ACTION)
    .replaceAll("@SHA@", sha);
}

function actionSha() {
  return gh(["api", `repos/${ACTION}/commits/main`, "--jq", ".sha"]).trim();
}

// The branch must hold exactly our workflow, pinned to a commit on agent-box's main whose
// runner code is still current; anything else could hand our ssh session to other code.
function verifyBranch(repo: string, owner: string): string {
  let tip: string;
  try {
    tip = gh(["api", `repos/${repo}/branches/${BRANCH}`, "--jq", ".commit.sha"]).trim();
  } catch (e) {
    if (!isNotFound(e)) throw e;
    return die(`${repo} has no ${BRANCH} branch; run \`box install ${repo}\``);
  }
  const rules = ghJson<{ type: string }[]>(`repos/${repo}/rules/branches/${BRANCH}`).map((r) => r.type);
  for (const r of ["update", "deletion", "non_fast_forward"])
    if (!rules.includes(r)) die(`${repo}:${BRANCH} is not locked (missing ${r} rule); run \`box install ${repo}\``);
  const file = ghJson<{ content: string }>(`repos/${repo}/contents/${WORKFLOW}?ref=${tip}`);
  const content = Buffer.from(file.content, "base64").toString("utf8");
  const pinned = /uses: [\w.-]+\/[\w.-]+@([0-9a-f]{40})\n/.exec(content)?.[1];
  if (!pinned || content !== renderWorkflow(owner, pinned))
    die(`${repo}:${WORKFLOW} is not the agent-box workflow; run \`box install ${repo}\``);
  const cmp = ghJson<{ status: string; files?: { filename: string }[] }>(`repos/${ACTION}/compare/${pinned}...main`);
  if (cmp.status !== "ahead" && cmp.status !== "identical") die(`${repo} pins ${pinned}, which is not on ${ACTION} main`);
  if (cmp.files?.some((f) => f.filename === "action.yml" || f.filename.startsWith("runner/")))
    die(`${repo} pins an older runner; run \`box install ${repo}\``);
  return tip;
}

// The artifact comes from the runner, so it is unpacked away from the lease directory and
// only box.json, with plain string fields, is accepted.
async function readBoxArtifact(repo: string, runId: number) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-box-"));
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        gh(["run", "download", String(runId), "-R", repo, "-n", "box", "-D", tmp]);
        break;
      } catch (e) {
        if (attempt >= 5) throw e;
        await sleep(3000);
      }
    }
    const files = fs.readdirSync(tmp);
    if (files.length !== 1 || files[0] !== "box.json") throw new Error(`unexpected artifact contents: ${files.join(", ")}`);
    const box = JSON.parse(fs.readFileSync(path.join(tmp, "box.json"), "utf8")) as Record<string, unknown>;
    const { host, hostKey, user } = box;
    if (typeof host !== "string" || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(host)) throw new Error("unexpected tunnel host");
    if (typeof hostKey !== "string" || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(hostKey)) throw new Error("unexpected host key");
    if (typeof user !== "string" || !/^[a-z_][a-z0-9_-]*$/.test(user)) throw new Error("unexpected user");
    return { host, hostKey, user };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- commands

async function up(args: string[]) {
  const [repo] = positional(args);
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) die("usage: box up <owner/repo> [--minutes N]");
  const minutes = flag(args, "--minutes") ?? "340";
  if (!/^\d+$/.test(minutes) || +minutes < 5 || +minutes > 340) die("--minutes must be 5..340");
  const c = config();
  ensureState();
  await ensureCloudflared();
  const tip = verifyBranch(repo, c.owner);

  const l: Lease = { id: randomBytes(5).toString("hex"), repo, created: new Date().toISOString() };
  const dir = leaseDir(l.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `agent-box-${l.id}`, "-f", `${dir}/id_ed25519`]);
  saveLease(l);

  try {
    const pubkey = fs.readFileSync(`${dir}/id_ed25519.pub`, "utf8").trim();
    gh(["workflow", "run", "agent-box.yml", "-R", l.repo, "--ref", BRANCH, "-f", `lease=${l.id}`, "-f", `pubkey=${pubkey}`, "-f", `minutes=${minutes}`]);
    log(`${l.id}: dispatched on ${l.repo}, waiting for a runner`);

    type Run = { id: number; display_title: string; head_sha: string; path: string; event: string; status: string; actor: { login: string }; html_url: string };
    let run: Run | undefined;
    for (let i = 0; i < 40 && !run; i++) {
      await sleep(3000);
      const runs = ghJson<{ workflow_runs: Run[] }>(`repos/${l.repo}/actions/runs?branch=${BRANCH}&event=workflow_dispatch&per_page=30`);
      run = runs.workflow_runs.find((r) => r.display_title === `agent-box ${l.id}`);
    }
    if (!run) throw new Error("the run never showed up");
    if (run.head_sha !== tip || run.path !== WORKFLOW || run.actor.login !== c.owner)
      throw new Error(`run ${run.id} is not the verified workflow`);
    l.runId = run.id;
    saveLease(l);

    let box: { host: string; hostKey: string; user: string } | undefined;
    for (let i = 0; i < 100 && !box; i++) {
      await sleep(3000);
      const { artifacts } = ghJson<{ artifacts: { name: string }[] }>(`repos/${l.repo}/actions/runs/${run.id}/artifacts`);
      if (artifacts.some((a) => a.name === "box")) box = await readBoxArtifact(l.repo, run.id);
      else if (ghJson<Run>(`repos/${l.repo}/actions/runs/${run.id}`).status === "completed")
        throw new Error(`run ended before the box came up: ${run.html_url}`);
    }
    if (!box) throw new Error("the box never came up");
    fs.writeFileSync(`${dir}/known_hosts`, `agent-box-${l.id} ${box.hostKey}\n`, { mode: 0o600 });
    writeSshConfig(l, box.host, box.user);
    await waitForSsh(l, 90);
    l.host = box.host;
    saveLease(l);

    const token = cloudflareToken(c);
    if (token) {
      try {
        await upgradeToNamed(l, c, token, box.user);
      } catch (e) {
        log(`staying on the quick tunnel: ${(e as Error).message}`);
        if (l.named) await deleteNamed(token, l.named).catch(() => {});
        l.named = undefined;
        writeSshConfig(l, box.host, box.user);
        saveLease(l);
      }
    }
  } catch (e) {
    log((e as Error).message);
    await release(l).catch((e: Error) => log(`${l.id}: ${e.message}; retry with \`box down ${l.id}\``));
    process.exit(1);
  }
  log(`${l.id}: ready on ${l.host} (${l.repo}, up to ${minutes} min, stops after 60 min idle)`);
  console.log(l.id);
}

const git = (args: string[], env?: NodeJS.ProcessEnv) =>
  execFileSync("git", args, { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }).trim();

// One parentless commit holding just the tree: no history, no stash index commit, so
// nothing that was ever committed or staged and later removed leaves this machine.
function snapshot(ref: string, untracked: boolean) {
  let tree: string;
  if (ref !== "HEAD") tree = git(["rev-parse", "--verify", `${ref}^{tree}`]);
  else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-box-"));
    try {
      const index = path.join(tmp, "index");
      const real = git(["rev-parse", "--path-format=absolute", "--git-path", "index"]);
      if (fs.existsSync(real)) fs.copyFileSync(real, index);
      git(["add", untracked ? "-A" : "-u", "--", ":/"], { GIT_INDEX_FILE: index });
      tree = git(["write-tree"], { GIT_INDEX_FILE: index });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const fixed = { GIT_AUTHOR_NAME: "agent-box", GIT_AUTHOR_EMAIL: "agent-box@localhost", GIT_AUTHOR_DATE: "@0 +0000" };
  const commit = git(["commit-tree", tree, "-m", "agent-box snapshot"], {
    ...fixed,
    GIT_COMMITTER_NAME: fixed.GIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: fixed.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_DATE: fixed.GIT_AUTHOR_DATE,
  });
  const changed = ref === "HEAD" ? git(["diff", "--name-only", "HEAD", tree]).split("\n").filter(Boolean) : [];
  return { commit, changed };
}

function remoteMatches(repo: string) {
  const want = repo.toLowerCase();
  return git(["remote", "-v"])
    .split("\n")
    .some((line) => /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s/.exec(line)?.[1]?.toLowerCase() === want);
}

function push(args: string[]) {
  const l = loadLease(args[0]);
  const ref = flag(args, "--ref") ?? "HEAD";
  if (!args.includes("--any-repo") && !remoteMatches(l.repo))
    die(`this checkout has no remote for ${l.repo}; pass --any-repo if that is intended`);
  const { commit, changed } = snapshot(ref, args.includes("--untracked"));
  const init = ssh(l, "git init -q ~/src", { timeout: 60_000 });
  if (init.status !== 0) die(`cannot prepare ~/src: ${init.stderr}`);
  const r = spawnSync(
    "git",
    ["push", "--quiet", "--force", "--no-verify", "--no-follow-tags", "--recurse-submodules=no", "box:src", `${commit}:refs/heads/box`],
    { stdio: "inherit", env: { ...process.env, GIT_SSH_COMMAND: `ssh -F ${sshConfig(l.id)}`, GIT_SSH_VARIANT: "ssh" } },
  );
  if (r.status !== 0) die("git push failed");
  const co = ssh(l, `git -C ~/src checkout -q --force --detach ${commit}`, { timeout: 120_000 });
  if (co.status !== 0) die(`checkout failed: ${co.stderr}`);
  const shown = changed.slice(0, 20).join(", ") + (changed.length > 20 ? `, … ${changed.length - 20} more` : "");
  log(`${l.id}: ~/src = ${ref}${changed.length ? ` + ${changed.length} changed file(s): ${shown}` : ""}`);
}

// What comes back from the box is untrusted: when it is not going to a terminal (an agent is
// reading it), strip escape sequences and control characters.
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f]/g;

function run(args: string[]) {
  const l = loadLease(args[0]);
  const command = args.slice(1).join(" ");
  if (!command) die("usage: box run <id> <command>");
  const child = spawn("ssh", ["-F", sshConfig(l.id), "box", `cd ~/src 2>/dev/null; ${command}`], { stdio: ["ignore", "pipe", "pipe"] });
  for (const [from, to] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ] as const) {
    const decoder = new StringDecoder("utf8");
    from.on("data", (chunk: Buffer) => to.write(to.isTTY ? chunk : decoder.write(chunk).replace(CONTROL, "")));
    from.on("end", () => to.isTTY || to.write(decoder.end().replace(CONTROL, "")));
  }
  child.on("close", (code) => process.exit(code ?? 255));
}

function shell(args: string[]) {
  const l = loadLease(args[0]);
  const r = spawnSync("ssh", ["-F", sshConfig(l.id), "-t", "box", "cd ~/src 2>/dev/null; exec bash -l"], { stdio: "inherit" });
  process.exit(r.status ?? 255);
}

// The stop file ends the run cleanly; the cancel covers a runner that ignores it.
async function release(l: Lease) {
  if (l.host && ssh(l, "touch ~/.box/stop", { timeout: 20_000 }).status === 0) log(`${l.id}: stopping`);
  if (l.runId) spawnSync("gh", ["run", "cancel", String(l.runId), "-R", l.repo], { stdio: "ignore" });
  if (fs.existsSync(sshConfig(l.id))) closeMaster(l);
  if (l.named) {
    const token = cloudflareToken(config());
    if (!token) throw new Error(`no cloudflare token to delete tunnel ${l.named.tunnelId}`);
    await deleteNamed(token, l.named);
  }
  fs.rmSync(leaseDir(l.id), { recursive: true, force: true });
  log(`${l.id}: released`);
}

async function down(args: string[]) {
  const l = loadLease(args[0]);
  await release(l).catch((e: Error) => die(`${l.id}: ${e.message}`));
}

function runStatus(l: Lease) {
  if (!l.runId) return "starting";
  try {
    const r = ghJson<{ status: string; conclusion: string | null }>(`repos/${l.repo}/actions/runs/${l.runId}`);
    return r.status === "completed" ? `ended (${r.conclusion})` : r.status;
  } catch {
    return "unknown";
  }
}

function ls() {
  for (const l of allLeases()) {
    const age = Math.round((Date.now() - Date.parse(l.created)) / 60_000);
    console.log(`${l.id}  ${l.repo.padEnd(28)} ${String(age).padStart(4)} min  ${runStatus(l).padEnd(14)} ${l.host ?? "-"}`);
  }
}

// Release leases whose runner is gone, then any agent-box tunnel or DNS record no lease owns.
async function gc() {
  for (const l of allLeases()) {
    const age = Date.now() - Date.parse(l.created);
    if (runStatus(l).startsWith("ended") || (!l.runId && age > 15 * 60_000))
      await release(l).catch((e: Error) => log(`${l.id}: ${e.message}`));
  }
  const c = config();
  const token = cloudflareToken(c);
  if (!token) return;
  const live = new Set(allLeases().map((l) => l.id));
  const { zoneId, accountId } = await zoneOf(token, c.zone!);
  const tunnels = await cf<{ id: string; name: string }[]>(token, `/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=100`);
  for (const t of tunnels) {
    const id = /^agent-box-([0-9a-f]{10})$/.exec(t.name)?.[1];
    if (!id || live.has(id)) continue;
    await deleteTunnel(token, accountId, t.id).then(
      () => log(`deleted tunnel ${t.name}`),
      (e: Error) => log(e.message),
    );
  }
  const records = await cf<{ id: string; name: string; comment: string | null }[]>(token, `/zones/${zoneId}/dns_records?type=CNAME&per_page=500`);
  for (const r of records) {
    const id = /^agent-box ([0-9a-f]{10}) /.exec(r.comment ?? "")?.[1];
    if (!id || live.has(id) || r.name !== `box-${id}.${c.zone}`) continue;
    await cf(token, `/zones/${zoneId}/dns_records/${r.id}`, "DELETE");
    log(`deleted dns ${r.name}`);
  }
}

// Put the workflow on an orphan `agent-box` branch and lock the branch to repo admins.
function install(args: string[]) {
  const repo = args[0];
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) die("usage: box install <owner/repo>");
  const c = config();
  const content = renderWorkflow(c.owner, actionSha());
  let tip: string | undefined;
  try {
    tip = gh(["api", `repos/${repo}/branches/${BRANCH}`, "--jq", ".commit.sha"]).trim();
  } catch (e) {
    if (!isNotFound(e)) throw e;
    tip = undefined;
  }
  const post = (api: string, body: unknown) =>
    JSON.parse(execFileSync("gh", ["api", "-X", "POST", api, "--input", "-"], { input: JSON.stringify(body), encoding: "utf8" })) as { sha: string };
  const tree = post(`repos/${repo}/git/trees`, { tree: [{ path: WORKFLOW, mode: "100644", type: "blob", content }] });
  const current = tip ? ghJson<{ tree: { sha: string } }>(`repos/${repo}/git/commits/${tip}`).tree.sha : undefined;
  if (current === tree.sha) log(`${repo}:${BRANCH} is up to date`);
  else {
    const commit = post(`repos/${repo}/git/commits`, { message: "agent-box: runner workflow", tree: tree.sha, parents: tip ? [tip] : [] });
    if (tip) execFileSync("gh", ["api", "-X", "PATCH", `repos/${repo}/git/refs/heads/${BRANCH}`, "-f", `sha=${commit.sha}`], { stdio: "ignore" });
    else post(`repos/${repo}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
    log(`${repo}:${BRANCH} -> ${commit.sha.slice(0, 10)}`);
  }
  const rulesets = ghJson<{ id: number; name: string }[]>(`repos/${repo}/rulesets`);
  const ruleset = {
    name: "agent-box",
    target: "branch",
    enforcement: "active",
    bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
    conditions: { ref_name: { include: [`refs/heads/${BRANCH}`], exclude: [] } },
    rules: [{ type: "update" }, { type: "deletion" }, { type: "non_fast_forward" }],
  };
  const existing = rulesets.find((r) => r.name === "agent-box");
  execFileSync("gh", ["api", "-X", existing ? "PUT" : "POST", `repos/${repo}/rulesets${existing ? `/${existing.id}` : ""}`, "--input", "-"], {
    input: JSON.stringify(ruleset),
    stdio: ["pipe", "ignore", "inherit"],
  });
  log(`${repo}:${BRANCH} locked to repo admins`);
}

function flag(args: string[], name: string) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function positional(args: string[]) {
  return args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
}

const USAGE = `usage:
  box install <owner/repo>        put the agent-box workflow on the repo's locked agent-box branch
  box up <owner/repo> [--minutes N]
                                  lease a runner; prints the lease id
  box push <id> [--ref REF] [--untracked] [--any-repo]
                                  send the working tree of tracked files (or REF's tree) to ~/src
                                  as one commit without history
  box run <id> <command>          run a command in ~/src and return its exit code
  box ssh <id>                    interactive shell
  box down <id>                   release the runner and its tunnel
  box ls                          list leases
  box gc                          release ended leases and orphaned tunnels`;

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "install":
    install(rest);
    break;
  case "up":
    await up(rest);
    break;
  case "push":
    push(rest);
    break;
  case "run":
    run(rest);
    break;
  case "ssh":
    shell(rest);
    break;
  case "down":
    await down(rest);
    break;
  case "ls":
    ls();
    break;
  case "gc":
    await gc();
    break;
  default:
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
}
