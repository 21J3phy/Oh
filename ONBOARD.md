# Onboard a teammate to Oh — paste-and-go

Send a teammate the prompt below; they paste it into **Claude Code** or **Codex**
and the agent sets Oh up end-to-end. The agent will ask them for their name and
OpenAI key, run setup non-interactively, seed their history, and tell them to
restart.

**Before you send it**, do the two `ADMIN:` substitutions:

- `ADMIN_FILL_SUPABASE_URL` → your project URL (default:
  `https://isyjdkayftpzzveamotf.supabase.co`)
- `ADMIN_FILL_SUPABASE_SECRET_KEY` → the team's **rotated** `sb_secret_…` key
- `ADMIN_FILL_GIT_PROJECT` → the git project to track (e.g. a repo name like
  `chadvschud`). Oh captures **only** sessions from this project, for everyone.

Share it over a secure channel (the prompt contains the shared secret key).

---

### Copy everything between the lines ↓↓↓

Set up **"Oh"** (our team's shared AI-coding memory) on my machine, end to end. Oh
captures our Claude/Codex sessions into a shared store so we can `ask` why code or
a decision is the way it is instead of interrupting each other.

Do the following, adapting as needed and showing me any errors:

1. **Clone & build** (if `~/oh` already exists, `cd ~/oh && git pull` instead):

   ```bash
   git clone https://github.com/21J3phy/Oh.git ~/oh && cd ~/oh && npm install
   ```

   `npm install` builds the package (a `prepare` step). Optionally run `npm link`
   to get an `oh` command on my PATH — if it fails on permissions, just use
   `node ~/oh/dist/cli.js …` in the steps below.

2. **Ask me for** (a) my name and (b) my OpenAI API key
   (https://platform.openai.com/api-keys). Then run init non-interactively,
   substituting my answers:

   ```bash
   node ~/oh/dist/cli.js init --yes \
     --author "MY_NAME" \
     --supabase-url "ADMIN_FILL_SUPABASE_URL" \
     --supabase-key "ADMIN_FILL_SUPABASE_SECRET_KEY" \
     --openai-key "MY_OPENAI_KEY" \
     --repos "ADMIN_FILL_GIT_PROJECT"
   ```

   This writes `~/.oh/config.json` and wires capture hooks, the `ask` MCP server,
   and the `ask-why` skill into **both** Claude Code and Codex (backing up each
   file first).

3. **Seed my existing history** into the shared store:

   ```bash
   node ~/oh/dist/cli.js backfill
   ```

4. **Tell me to fully restart Claude Code and Codex** so they load the new MCP
   server, hooks, and skill. (Codex may ask me to *trust* the new hook on its next
   run — that's expected; approve it.)

When done, confirm setup with `node ~/oh/dist/cli.js status` (it should show a
chunk count > 0). After that, in either tool I can just say **"ask why we did X"**
and my agent will pull the relevant reasoning — mine or a teammate's — with a
citation.

### ↑↑↑ Copy everything between the lines

---

That's it — no manual config editing. The one-time Supabase project + schema are
already set up; each teammate only needs this prompt, their name, and an OpenAI
key.
