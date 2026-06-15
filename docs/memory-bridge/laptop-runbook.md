# Laptop runbook — join the cross-device sync

Get this laptop sharing one vault and one memory brain with the desktop, over Google Drive.
Spec: [`08-cross-device-sync.md`](08-cross-device-sync.md). Do these steps **once** in order.

## What this sets up

| Data | Transport | Lives where |
|------|-----------|-------------|
| Vault notes (Obsidian markdown) | Google Drive folder sync | `<Drive>\kaiba-sync\vault\` (shared) |
| Memory brain (`memories` table) | per-machine NDJSON merged by `kb memory-sync` | `<Drive>\kaiba-sync\brain\kaiba-brain.<host>.ndjson` (shared) |
| `kb.db` (index + brain rows) | **never synced** | `~\.knowledge-base\kb.db` (local only) |

> **HARD RULE — `kb.db` NEVER goes into Google Drive.** Two machines writing one SQLite file over
> cloud sync = corruption (WAL + partial syncs + concurrent writers). Only the vault files and the
> NDJSON brain files cross Drive. The index is derived and rebuildable (`kb vault reindex`); the
> brain travels by explicit merge (`kb memory-sync`), never by copying the db.

The desktop must already have pushed its brain at least once (`kb memory-sync` there, which writes
`kaiba-brain.<desktop-host>.ndjson` into the brain dir). If it hasn't, do the desktop side first or
this laptop will have nothing to pull on its first sync.

---

## Checklist

### 1. Pre-flight

- [ ] **Google Drive for Desktop is running and idle (fully synced).** Check the Drive tray icon —
      it should say "Up to date", not "Syncing". Sync must finish before and after you move files.
- [ ] **Find this laptop's Drive mount path.** It is usually `%USERPROFILE%\My Drive`
      (e.g. `C:\Users\<you>\My Drive`). The desktop uses `C:\Users\Admin\My Drive` — **do NOT assume
      this laptop matches.** The username and the drive letter may differ. Confirm the real path:
      ```powershell
      "$env:USERPROFILE\My Drive"        # most common
      Get-ChildItem "$env:USERPROFILE" -Filter "*Drive*" -Directory   # if the above is wrong
      ```
      Call the confirmed path `<Drive>` for the rest of this runbook.
- [ ] **Locate the current vault.** It is in a *local, non-synced* folder right now. If unsure:
      ```powershell
      (Get-Content "$HOME\.knowledge-base\.env" | Select-String '^OBSIDIAN_VAULT_PATH=')
      ```
      Note this path — the setup script needs it as `-VaultPath`.

### 2. Move the vault into Drive (ONCE)

Why: the vault must live inside `<Drive>\kaiba-sync\vault\` so Drive replicates it to the desktop.
After this, **both machines point `OBSIDIAN_VAULT_PATH` at the synced copy** and reindex into their
own local `kb.db`.

- [ ] **Safety copy first**, then copy the vault into Drive. The setup script does this for you
      (`scripts\setup-laptop.ps1`), or by hand:
      ```powershell
      $vault = "<current vault path>"
      Copy-Item $vault "$HOME\kaiba-vault-backup-$(Get-Date -f yyyyMMdd)" -Recurse   # safety copy
      New-Item -ItemType Directory -Force "<Drive>\kaiba-sync\vault" | Out-Null
      Copy-Item "$vault\*" "<Drive>\kaiba-sync\vault\" -Recurse -Force               # copy IN
      ```
- [ ] **Leave the original folder where it is** — do not delete it yet. Just stop using it. Once both
      machines are verified converged (step 7) you can remove the original at your leisure.
- [ ] **Wait for Drive to finish uploading** `kaiba-sync\vault\` (tray icon → "Up to date") before
      touching the desktop.

### 3. Set env vars in `~\.knowledge-base\.env`

Two keys (the setup script writes/merges these without clobbering your existing keys):

```
OBSIDIAN_VAULT_PATH=<Drive>\kaiba-sync\vault
KB_BRAIN_SYNC_DIR=<Drive>\kaiba-sync\brain
```

- `OBSIDIAN_VAULT_PATH` — now points at the **synced** vault, not the old local one.
- `KB_BRAIN_SYNC_DIR` — the shared brain dir where each machine drops its `kaiba-brain.<host>.ndjson`.
  (If unset, `kb memory-sync` defaults to `<homedir>\My Drive\kaiba-sync\brain` — set it explicitly so
  it's correct even if this laptop's Drive path is non-standard.)
- `KB_MACHINE_ID` *(optional)* — the per-machine brain file is named from `os.hostname()`. If this laptop
  and the desktop happen to share a hostname, their files collide (one overwrites the other in Drive and a
  machine re-imports its own export). Only then, set a distinct `KB_MACHINE_ID=laptop` here so the files
  stay separate (`kaiba-brain.laptop.ndjson`). Leave it unset if the hostnames already differ.

Do **not** put `KB_PASSWORD` in any script — set it in `.env` or pass it on the `kb start` command line.

### 4. Rebuild the local index from the moved vault

```powershell
kb vault reindex
```

This re-reads the vault from its new synced path and rebuilds this laptop's local `kb.db` index
(hash-based incremental). Nothing here goes into Drive.

### 5. Install the memory spine (if not already)

```powershell
kb spine install      # idempotent; "kb spine status" to check first
```

Wires the SessionStart→`kb brief` (auto-load) and Stop→`kb consolidate` (auto-save) hooks so
sessions on this laptop both read from and write to the brain. Skip if already installed.

### 6. First memory sync

```powershell
kb memory-sync --dry-run     # reports counts, writes NOTHING (not db, not your own file)
kb memory-sync               # pull every OTHER machine's brain file, then (re)write your own
```

- The dry run should report the desktop's machine file and a non-zero "pull" count (its memories
  reaching this laptop). If it shows zero machines, the desktop hasn't pushed yet — see step 9.
- `kb memory-sync` is the **trusted** merge: it preserves `review_status`, `confidence`, provenance,
  and outcomes across the round-trip (both files are *your own* machines). Use it for all ongoing
  sync. It is bidirectional, convergent, idempotent, and non-destructive — re-running with no changes
  writes nothing new and never resurrects a rejected/superseded memory.
- **One-off alternative only:** to seed this laptop from a brain export you carried over by hand (NOT
  from a trusted machine you own), use `kb memory-import <file.ndjson>`. That is the **untrusted** path
  — it forces every imported memory back into the review queue (`pending`) and caps confidence. Prefer
  `kb memory-sync` for anything between your own machines.

### 7. Verify convergence

- [ ] `kb brief` — the session brief should now include memories that originated on the desktop.
- [ ] `kb search "<a term you know is only in a desktop note>"` — a vault note authored on the desktop
      should be findable here (proves the vault replicated and reindexed).
- [ ] **Convergence check (both machines):** after the laptop syncs, run `kb memory-sync` on the
      **desktop** too. Then re-run `kb memory-sync --dry-run` on each — both should report 0 new pulls.
      That confirms both hold the same logical set (union). Order doesn't matter: whichever side syncs
      first, the end state is identical.

### 8. Ongoing routine

- The spine auto-loads/saves the brain per session. **Memory sync is explicit** — run
  `kb memory-sync` when you want the two brains to converge (e.g. at the start or end of a work block
  on whichever machine you're on). A simple habit: sync at the start of a session and after a session
  that created or corrected memories.
- Vault: edit notes in `<Drive>\kaiba-sync\vault\`; run `kb vault reindex` on a machine after Drive
  brings down changes, to refresh that machine's local index.
- **HARD RULE (repeat): never put `kb.db` in Drive.** Only the vault and the NDJSON brain files belong
  in `kaiba-sync\`.
- **Simultaneous-edit caveat:** editing the *same vault note* on both machines at once can make Drive
  create a conflict copy (e.g. `note (1).md`). Fine for not-at-the-same-time use. If you routinely edit
  on both at once, upgrade to Obsidian Sync or a git-backed vault (out of scope here — document, don't
  build). The NDJSON brain avoids this by design: each machine owns and overwrites only its **own**
  `kaiba-brain.<host>.ndjson`, so there is no shared-file write contention.

### 9. Rollback / troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Vault doesn't appear on the desktop | Drive not finished uploading — check the laptop tray icon says "Up to date", then check the desktop is "Up to date" too. Confirm both see `<Drive>\kaiba-sync\vault\`. |
| `kb memory-sync` reports 0 machines / sync dir empty | The desktop hasn't pushed its brain yet. Run `kb memory-sync` on the **desktop** first (it writes `kaiba-brain.<desktop-host>.ndjson`), wait for Drive to upload it, then retry here. Verify `KB_BRAIN_SYNC_DIR` points at the real `<Drive>\kaiba-sync\brain`. |
| `kb vault reindex` finds nothing | `OBSIDIAN_VAULT_PATH` still points at the **old local** path. Re-check `.env`; it must be the moved `<Drive>\kaiba-sync\vault` path. |
| Drive path differs from the desktop's | Expected — never hardcode `C:\Users\Admin\My Drive`. Always derive from `%USERPROFILE%\My Drive` or set `<Drive>` explicitly. Set `KB_BRAIN_SYNC_DIR` and `OBSIDIAN_VAULT_PATH` to **this** laptop's real paths. |
| Sync pulls 0 / a machine re-imports its own memories | Both machines resolve to the **same** `os.hostname()`, so they write the same `kaiba-brain.<host>.ndjson` and clobber each other. Set a distinct `KB_MACHINE_ID` (e.g. `laptop`) on one machine, then `kb memory-sync` again. Check the brain dir holds **two** differently-named files. |
| Want to undo the move | The original vault is still in its old local folder (you didn't delete it). Point `OBSIDIAN_VAULT_PATH` back at it and `kb vault reindex`. Remove `kaiba-sync\vault` from Drive if abandoning sync. |
| A memory you rejected reappears | It won't via `kb memory-sync` (rejection is terminal and propagates). If it came back, you likely used `kb memory-import` (untrusted, re-review) — reject it again; sync will keep it rejected from then on. |

---

**Recap of the contract:** vault → Drive folder sync; brain → `kb memory-sync` (trusted merge of
per-machine NDJSON); `kb.db` → local only, forever. Use `kb memory-import` only for a one-off untrusted
seed. Run `scripts\setup-laptop.ps1 -VaultPath <path>` to do steps 2–4 and the first dry-run
automatically.
