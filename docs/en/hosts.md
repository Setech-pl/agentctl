# Hosts: remote tasks over SSH

A spec with `host: pc` runs its worktree, repository setup and interactive agent on the configured host. The dispatcher keeps task state and the local report mirror. Install Git, tmux, Node and the selected provider CLI on the host, log in as the SSH owner, and keep a separate clone of each repository there. No remote agentctl installation is needed. The owner account is assumed: generated hooks and settings belong to that account and are installed in task-owned files, without editing the owner's provider settings.

Add to the dispatcher's existing global config (keep its other keys):

```yaml
hosts:
  pc:
    ssh: owner@pc.local
    port: 22
    work_dir: ~/agentctl-work
    repos:
      app: ~/src/app
    providers: [claude, codex, kimi, glm]
    limits: {claude: 1, codex: 1, kimi: 1, glm: 1}
    # env: {PATH: /home/owner/.local/bin:/usr/local/bin:/usr/bin:/bin}
```

List only installed/logged-in providers. `env.PATH` can expose CLIs installed outside the noninteractive SSH shell's PATH. `identity_file` is an optional **local** key path. Never put credentials in this config; provider login stays on the host. For Windows/WSL use the SSH endpoint and forwarded port of WSL, e.g. `ssh: owner@192.168.2.64`, `port: 2222`.

Accept a first-time SSH key once in your own terminal (`agentctl doctor` prints the command), then check `agentctl hosts --refresh`. Agentctl fixes `BatchMode=yes` and `StrictHostKeyChecking=yes`; unknown, changed and unauthenticated hosts never prompt or auto-accept. Each host reuses one multiplexed SSH channel. The configured hostname is passed on every call, without an IP cache.

Save a spec as `remote.md`:

```yaml
---
task: PC-SMOKE
host: pc
agent: claude
model: sonnet
effort: high
review: false
repos:
  - path: app
    base: origin/main
    branch: pc-smoke
---
Inspect the repository and write a short report. Do not change files or commit.
```

Run `agentctl new remote.md --no-wait-trust`, then `agentctl attach PC-SMOKE`: for a host task it prints the `ssh -t … 'tmux attach …'` command. Run that command, approve the folder trust yourself, and leave watch running (`agentctl watch --tmux`). Detach with Ctrl-b d to return to your local terminal; F12 is the local board key and does not jump between hosts. Board Enter also shows the remote attach command and the task carries a `[pc]` badge.

`repos[].path` names a configured clone (its name or a path whose basename is that name). Agentctl fetches `origin` there, never pushes, then creates a branch or detached checkout using the same base/branch rules as local tasks. Prefer `origin/main` over a potentially stale local `main`. Missing bases identify the host clone's default branch. Worktrees must be separate directories inside `work_dir`; defaults are `<work_dir>/<repo>-<task>`. Setup is read from each new worktree's `.agentctl.yaml`; an explicit spec setup overrides it, including `[]`. Remote project links and environment run on the host; local project files and global links are not copied there.

The existing provider adapters handle readiness, trust, questions, prompt paste and delivery verification. Claude/GLM receive task-owned, repeatable hook/settings installation, reported at start. Codex preserves the owner's notify command and uses its named rollout for exact delivery proof; Kimi uses its task-bound state/wire protocol. Unknown Kimi protocols provide screen state only and cannot acknowledge a follow-up. `peek`, `send` (including Codex FIFO until turn end), token-bound `answer`, `interrupt`, `close` and `cancel` route to the remote window. An explicit `close --rm-worktree` removes a registered remote worktree through Git without force; branches stay.

The canonical remote report is `<work_dir>/reports/<task>/<TASK>.md`. The spec's `report:` remains the **local mirror** (normally under `config.cache`). Watch copies changed content and samples again when the task ends or is explicitly closed/cancelled; `get_report`, outputs parsing and pull read that mirror. Outputs branch/SHA checks run against the host clone and cache their validation for offline reads. The report must follow the normal attempt/report-end protocol.

SSH loss changes the task to `host-unreachable`, keeps it active and occupying a slot, emits an event and notification, and retries after 5 seconds with exponential backoff capped at 5 minutes. Tracking resumes when the host answers. Watch never closes remote windows by itself. Explicit operations report connection failures without marking a live remote task closed/cancelled.

Every remote task uses the provider account limit alongside local tasks and reservations; `hosts.<name>.limits` adds a host/provider cap. See the complete maintenance and restart behavior below.

## 0.23.0 maintenance, limits and restart

`limits`, `capacity`, board `L`/`C` and `H` show per-host provider caps alongside the shared account limits. A provider hold applies to local and remote queue entries, including direct starts; unreachable tasks retain their slots. Watch samples disk free space in each host's `work_dir`; capacity/board show the host name, and disk threshold changes emit events. Unknown or stale host samples are n/d, never presented as current free space.

Use `agentctl move TASK --host pc` or `--host local` for a queued, never-started task. The preview and y/N confirmation preserve its ID, priority, position, dependencies, prompt and provider. Running, starting, retry/reuse and automatic-review entries cannot change location. No files are transferred. Use a local absolute `repos[].path` whose basename matches a host clone and configure local `worktree_root` for a round trip; the original local worktree path is retained while the remote location uses its own default.

`gc --preview` measures finished remote worktrees and task-owned settings/cache over SSH, with a 5-second/100,000-entry walk budget and a 10-second transport ceiling per host. Measurements are cached for 60 seconds; cached previews skip missing/stale samples with a reason. Explicit CLI previews refresh them. `gc --apply` and MCP `gc` require the normal owner confirmation. Every removal rechecks task ownership, active windows, shared/link references, registered clean worktrees, protected main/master and cache age on the host. Git worktree removal is never forced. Unknown directories, symlinks and reports (*.md, including nested reports) stay; remote branch deletion and local mirror/state deletion are outside remote GC. A budget or SSH failure keeps the target and explains the skip.

After watch restarts it rediscovers remote windows by task ID, refreshes their tmux IDs and resumes observation without launching a second agent. `resume TASK` recreates a genuinely missing remote window, with remote hooks and report instructions; an offline host is never treated as an empty tmux server. If local TASK.md was lost, `adopt TASK --host pc --report /absolute/local/mirror/TASK.md --agent claude --model sonnet --effort high` identifies the existing remote window. Supply `--worktree /remote/worktree` when known; `--remote-report` overrides the standard remote report path. Original prompt history cannot be reconstructed by adopt. Remote automatic reviews remain explicit separate tasks (`review: false`).

## First real PC test: WSL2 → Windows → Mac

Use WSL2 Ubuntu as user **krzet**, Windows LAN address **192.168.2.64**, SSH exposed at **2222**. Commands below are owner actions; they launch one real Claude task. Keep repository clones and worktrees in WSL's Linux filesystem.

1. **WSL, once:** install SSH/Git/tmux and a supported Node (>=22.14.0; check `node --version`, follow the [Node installation guide](https://nodejs.org/en/download) if missing). Then:

   ```sh
   sudo apt-get update
   sudo apt-get install -y openssh-server git tmux
   sudo ssh-keygen -A
   sudo service ssh start
   # With systemd enabled: sudo systemctl enable --now ssh
   mkdir -p ~/.ssh ~/src ~/agentctl-work
   chmod 700 ~/.ssh
   npm install -g @anthropic-ai/claude-code
   claude
   # Complete login, then exit the CLI.
   git clone https://github.com/Setech-pl/agentctl.git ~/src/agentctl
   ```

   Put the Mac's public SSH key into `~/.ssh/authorized_keys` on WSL and run `chmod 600 ~/.ssh/authorized_keys`. Verify `whoami` prints `krzet` and `ss -lnt` shows SSH on port 22. Enable systemd by adding `[boot]` / `systemd=true` to `/etc/wsl.conf` if needed, then run `wsl --shutdown` from Windows and reopen Ubuntu; do not shut WSL down while tasks run.

2. **Windows Administrator PowerShell, once:** replace `Ubuntu` if `wsl -l -v` shows a different distribution name.

   ```powershell
   $pcWslIp = ((wsl -d Ubuntu hostname -I).Trim() -split '\s+')[0]
   netsh interface portproxy add v4tov4 listenaddress=192.168.2.64 listenport=2222 connectaddress=$pcWslIp connectport=22
   New-NetFirewallRule -DisplayName 'agentctl WSL SSH 2222' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 2222 -Profile Private -RemoteAddress LocalSubnet
   netsh interface portproxy show v4tov4
   ```

   After a Windows/WSL reboot, reopen Ubuntu, start SSH, obtain its new IP and update the forwarding target:

   ```powershell
   $pcWslIp = ((wsl -d Ubuntu hostname -I).Trim() -split '\s+')[0]
   netsh interface portproxy set v4tov4 listenaddress=192.168.2.64 listenport=2222 connectaddress=$pcWslIp connectport=22
   Test-NetConnection 192.168.2.64 -Port 2222
   ```

   Reserve the Windows LAN IP in DHCP. If that IP changes too, update `listenaddress` and `hosts.pc.ssh`. WSL NAT IP and Windows LAN IP are different. See Microsoft's [WSL networking](https://learn.microsoft.com/windows/wsl/networking) and [systemd setup](https://learn.microsoft.com/windows/wsl/systemd).

3. **Mac, once:** `ssh-keygen -t ed25519` if you have no key; install its `.pub` in WSL as above. Run `ssh -p 2222 krzet@192.168.2.64`, verify the fingerprint on WSL (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`), accept it, then exit. Verify unattended access:

   ```sh
   ssh -o BatchMode=yes -p 2222 krzet@192.168.2.64 'whoami; tmux -V; node --version; command -v claude'
   ```

   Add this to the existing Mac config (normally `~/.agentctl/config.yaml`):

   ```yaml
   hosts:
     pc:
       ssh: krzet@192.168.2.64
       port: 2222
       work_dir: /home/krzet/agentctl-work
       repos: {agentctl: /home/krzet/src/agentctl}
       providers: [claude]
       limits: {claude: 1}
       env: {PATH: /home/krzet/.local/bin:/usr/local/bin:/usr/bin:/bin}
   ```

   If Node/Claude were installed with nvm/npm under another prefix, replace `env.PATH` with the WSL output of `printf '%s\n' "$PATH"`; verify the same noninteractive SSH check again. Save `pc-smoke.md`:

   ```yaml
   ---
   task: PC-SMOKE-1
   host: pc
   agent: claude
   model: sonnet
   effort: high
   review: false
   setup: []
   repos: [{path: agentctl, base: origin/main, branch: pc-smoke-1}]
   ---
   Read package.json and report its package name and version. Do not change files or commit.
   ```

   Run `agentctl hosts --refresh`, `agentctl watch --tmux`, then `agentctl new pc-smoke.md --no-wait-trust`. Run the exact SSH command printed by `agentctl attach PC-SMOKE-1`, approve folder trust, and detach with Ctrl-b d. Verify `[pc]`/`H` on the board and `agentctl pull PC-SMOKE-1`. Finally close the task and preview GC; review the plan before applying it.

## Troubleshooting

| Symptom | Owner check / remedy |
| --- | --- |
| host-key-unknown | Run doctor's one-off SSH command and verify the fingerprint on the host before accepting. |
| HOST KEY CHANGED | Verify the host fingerprint/address first; after a confirmed reinstall, remove only the old entry with `ssh-keygen -R '[192.168.2.64]:2222'`, reconnect manually. Never disable strict checking. |
| auth-failed / Permission denied | Test BatchMode SSH; verify user krzet, authorized_keys permissions, the correct key/ssh-agent or local identity_file. Windows SSH credentials do not log into WSL. |
| Connection refused / timeout after reboot | Start WSL and sshd; refresh portproxy's WSL IP, check the Windows LAN IP, Private firewall rule and port 2222. |
| tmux missing | Install tmux inside WSL, then verify `ssh -p 2222 krzet@192.168.2.64 'tmux -V'`. |
| Provider missing / logged out | Install and log in as krzet inside WSL, not Windows or root. Verify the noninteractive PATH; run the CLI manually to log in. Health login detection is best effort; a credential file does not prove token validity. |
| GC skipped | Read the reason; finish/close the task, commit intended changes, resolve links or wait for the age limit. No force deletion. |
| New task cannot start | Check both the account hold/limit and host limit in `limits`/`capacity`; provider holds affect the remote queue too. |
