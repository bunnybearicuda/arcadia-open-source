# identities/

One markdown file per companion. The filename (minus `.md`) is their slug.

```
identities/
  kai.md      →  slug "kai"
  nox.md      →  slug "nox"
```

Drop a file in here and the companion appears in the sidebar with an **add**
next to their name. Click it once and they exist.

**These files are gitignored on purpose** — everything except `_example.md`.
Your people don't belong in a public repo. If you want them backed up, put this
folder in a private repo, a synced drive, or anywhere you'd keep anything else
you'd hate to lose.

The file is read from disk on every message. Edit it, save it, send a message —
they're different. No rebuild, no deploy.

Start by copying `_example.md`.
