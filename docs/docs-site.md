# The docs site

The docs site is the public help for people who use Infinitary, published at `docs.getinfinitary.com`.
Its pages live in this repository, in `docs-site/`, so a change to the app can update its page in the same pull request.
`docs/` and `primitives/` stay the project's own pages and are never published there.

## Where pages live

`docs-site/` is its own package, with its own `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`, outside the app's workspace.
A change to the site never moves the app's dependencies, and the app's install never reaches the site's.
It is Starlight on Astro, pinned exactly.

Each page is a Markdown file under `docs-site/src/content/docs/`; its address is its file name (`install.md` is `/install/`, `index.md` is the home page).
The sidebar in `docs-site/astro.config.mjs` lists each page by hand, so it shows only pages that exist.
A new page adds its file and its sidebar entry together.
The sidebar has three groups: Start, Using Infinitary and Reference.

### Generated pages

Two pages are written from the app's own data, so neither tells a person something the app does not do.

- **Keyboard** (`keyboard.mdx`) is written by `node scripts/docs-site-keyboard.ts` from the app's command list (`KEYBOARD_COMMANDS` in `src/shared/keyboardCommands.ts`), the presets (`src/shared/keyPresets.ts`) and the app's own panels' commands (`src/panels/*/manifest.json`), each named in the words the window gives it (`commandEntry`).
  Each preset is a tab, and each command shows the keys the window resolves for that preset with nothing changed, on a Mac and on Linux or Windows (`resolveBindings`), so a key the app leaves out is left out here too.
  A command that acts in a Settings section some builds do not offer (`section`) is left out.
  Each shipped language has its own Keyboard page, with each command in the words the app's catalog gives it in that language and the page's own sentences from the language's words file ("Languages").
  The pages are committed, and `pnpm check` runs `node scripts/docs-site-keyboard.ts --check`, so a change to a command's words or keys regenerates every language's page in the same pull request.
- **What's new** (`whats-new.md`) and each stable's own page (`whats-new/<version with dashes>.md`, such as `/whats-new/0-8-6/`) are written by `node scripts/docs-site-whats-new.ts`, which the site's `build` and `dev` run first, from the release-notes ledger (`docs/release-notes.md`).
  A release's changes are what it added over the stable before it, grouped by area in the app's order, without backfilled history or maintenance, as the startup note measures them.
  Each change shows its title, with its detail folded under it in a disclosure, as the app's What's new card folds every change under "All N changes".
  What's new shows the five newest stables, a release heading each (`## 0.8.7`), and ends with "Every release", a line linking each stable that changed something to its own page, so a release stays on the site once newer ones push it off What's new.
  A stable that changed nothing a person sees gets no page of its own.
  The Discord announcement of a stable links to its own page and waits for the site to serve it (`docs/alpha.md`, "Announcing a stable").
  The pages are not in the sidebar; What's new links to them.
  They combine local stable tags with the archived stable manifests, newest first, without repeating a version.
  They are not committed (`docs-site/.gitignore`), and the script replaces the whole `whats-new/` folder on each run; unpinned local releases still require full history and tags, and a shallow checkout refuses to build.
  The site therefore shows a new stable's changes only once the site is built again after its tag.

`tests/docs-site-pages.test.ts` holds both: each Keyboard tab shows, first, the key the app's own hint shows for each command, and What's new lists only what a stable added over the one before it, filed under its area, each title shown with its detail folded, and every stable with changes on a page of its own listed under "Every release".

### Pictures

A page's pictures are dark and light pairs under `docs-site/public/pictures/`, taken through the hermetic launcher with `heroShot` (`tests/e2e/pictures.ts`), the way release-note hero pictures are, with made-up projects and tasks.
A page shows both through the `.picture-dark` and `.picture-light` classes in `docs-site/src/styles/infinitary.css`, so each follows the site's theme.
Retake a picture when the view it shows changes enough to mislead.

## Languages

The site speaks the app's own languages, the folders of its catalog (`src/shared/i18n/messages/`, `docs/i18n.md`), read by `docs-site/languages.ts` and never typed a second time.
English is the source and keeps every address it has.
Each other language lives under its catalog tag in lowercase, such as `/ar/` or `/zh-hans/`, with its pages in `docs-site/src/content/docs/<tag in lowercase>/`.
A language ships when that folder exists; its pages carry the catalog tag as their `lang`, and Arabic runs right to left.
A language appears only with every page translated, so no reader gets a translated frame around English words.

A catalog language that has not shipped yet answers its addresses with a temporary redirect to the same English page, written by the build to `dist/_redirects`, so a link to it never leads nowhere.
Every page names itself as its canonical address and its version in each shipped language, with English as `x-default`, as alternates, and the sitemap carries the same, its `x-default` added by the build since Starlight's sitemap names only the languages; the language menu names each shipped language in itself.
The language menu and the theme menu show each name whole in every language, never cut short: where the browser can size a menu to its choice, each fits the name it shows, and elsewhere each is as wide as its longest name (`docs-site/src/styles/infinitary.css`), since Starlight's own fixed widths cut names such as Français, 简体中文, German's System and French's Sombre short.

### Words

`docs-site/words/<tag>.json` holds the site's own words in each language: the sidebar's group names and its home link for every catalog language, and the Keyboard page's own sentences for each shipped one.
Starlight brings its menus', search's and notices' words for most languages; `docs-site/src/content/i18n/` adds them for the ones it lacks (`zh-Hans`, `zh-Hant`) and the words it leaves in English for a language, such as a heading link's label in Arabic and Japanese.
The search window's own words (its result count, clear button and the rest, Starlight's `pagefind.*` words) come from that folder too: Starlight brings none, and Pagefind's search window does not pick its own by the page's language, so a shipped language adds them there.
Text in Chinese, Japanese, Korean and Arabic takes the visitor's own typeface for its script from the design skill's `tokens/typography.css`, imported in Starlight's lowest layer so only its custom properties reach the site, with tracking at zero; no font file is added and nothing loads from another host.

### Translated pages

A translated page has the English page's file name in its language's folder.
Its headings end with the English heading's id (`## المتطلبات {#requirements}`), so a link to a heading works the same in every language, and its links to the site's pages carry its language's segment (`/ar/install/`).
Its frontmatter's `source` is the fingerprint of the English page it was written from.
Write a translation from the language's glossary (`.claude/skills/infinitary-design/copy/glossary/<tag>.md`), one sentence per line, keeping "Infinitary", key names and code as written, and the app's own words for what it shows on screen; add a term the glossary lacks to it.
A browser draws a line break inside a paragraph as a space, which Chinese and Japanese never put between sentences or after full-width punctuation, so the site's Markdown step (`docs-site/sentence-lines.mjs`) drops a line break between two Chinese or Japanese characters, or beside full-width punctuation such as 。 or 」, leaving nothing in its place.
A quotation mark that closes a Chinese or Japanese sentence, as in 看不到。”, counts as full-width punctuation; Korean, which puts spaces between words, and every other language keep their space.
In a right-to-left language, a key written in prose sits in `<bdi dir="ltr">⇧⌘]</bdi>`, so it keeps its order and its brackets; `<kbd>` is isolated the same way by the site's stylesheet.
Then record the fingerprint:

```sh
node scripts/docs-site-languages.ts --stamp docs-site/src/content/docs/ar/install.md
```

Whoever changes an English page writes every shipped language's version in the same pull request, and stamps each once it is re-read.
Keyboard is generated in each shipped language (`node scripts/docs-site-keyboard.ts`), and What's new and each stable's own page stay English in every language under Starlight's notice that the page is not translated yet, since release notes are written in English only; the notes are marked English and the notice, through `src/components/FallbackContentNotice.astro`, the reader's language and direction.

### The languages check

`node scripts/docs-site-languages.ts --check` runs in `pnpm check`.
It never judges the prose; it refuses a shipped language that lacks a page English has, folders included, or holds one English lacks, a translated page whose `source` is not the English page's current fingerprint, a translated page whose links (its language's segment aside), pictures, code, keys, frontmatter, line for line with nested values included (title and description aside) or headings' levels and ids differ from the English page's, a translated page's link to an English page, however it is written, and a catalog language whose words file is missing, lacks a word the site reads in it (the sidebar's for every language, the Keyboard page's for each shipped one), has a blank one or one the site does not use.
`tests/docs-site-languages.test.ts` holds it to the site's own pages.

### Adding a language

Add `docs-site/src/content/docs/<tag in lowercase>/` with every hand-written page translated and stamped, the language's words in `docs-site/words/<tag>.json`, and run `node scripts/docs-site-keyboard.ts` for its Keyboard page.
The redirect for it goes away, its menu entry, alternates and search appear, and the site and live checks open its pages, with no other change.
Its file under `docs-site/src/content/i18n/` holds its search window's words, and the words Starlight brings none for.

## Build and check

```sh
pnpm --dir docs-site install --frozen-lockfile
pnpm --dir docs-site build
pnpm --dir docs-site check
```

The build writes plain files to `docs-site/dist/`, search index included.
`pnpm --dir docs-site dev` serves the site while you edit.

### The check

`docs-site/scripts/check-site.mjs` serves `dist/` on this computer and opens every built page in Chromium through Playwright, in a browser that may reach only that server.
It opens pages side by side, and fails on a page that does not answer or draws no title, a page that does not name its language, direction, canonical address and alternates or labels its heading links in another language's words ("Languages"), a shipped language's home page whose language menu cuts its name short or whose theme menu cuts any of its choices short, a request to any other host, a cookie, a link between pages or to a heading that leads nowhere, a picture that does not draw, a space drawn after a full-width full stop (。), an unknown address that does not draw the site's own not-found page, search that draws no search box on a shipped language's home page, or finds nothing in English or, from each shipped language's home page, for a word of its Install page's title, finding that language's pages, or whose result count or clear button reads as English's on a translated home page, a sitemap entry whose alternates differ from its page's, a translated What's new that does not show the English notes, marked English, under Starlight's notice in its language and marked so, and a wordmark drawn in anything but the text color at weight 500.
Starlight builds the search box only when the browser next has idle time, and headless Chromium on a busy computer can stop drawing without ever having it, so the check waits for the box while asking the page for animation frames, as a visitor's pointer would.
Each search opens in a fresh tab, because a tab that walked page after page keeps those pages in its browser's memory, and on a busy computer such a tab sometimes never gets that idle time.
It also opens the home page with the system asking for dark and then for light, and fails unless the site follows.
`SCREENSHOTS=<folder>` saves the home, install and first launch pages in both themes there.

`--origin <address>` opens the pages at that address instead of serving `dist/`, and fails on anything the site's security policy blocks.

`.github/workflows/docs-site.yml` runs the build, the check, the site's tests (`pnpm --dir docs-site test`: the publish checks' and the Markdown step's) and a publish rehearsal on each pushed task branch and pull request that touches `docs-site/`, the token and font files it reads, the app icon, the What's new script, the language list, the release-notes ledger or the workflow itself (a catalog message edit starts nothing: the site reads only the catalog's folder names, and a new language adds its words file under `docs-site/`), with the full history the What's new page reads.
It holds no secret and publishes nothing.

The app's own checks leave the site alone: `docs-site/` is one of `scripts/pr-paths.ts`'s light paths, so a change to the site alone skips the app's build and the critical path, and it is in `main.yml`'s `paths-ignore`, so it starts no desktop release check.
It is not on `scripts/desktop-build.ts`'s list, so it never cuts an alpha.
The size check and the old-name ledger read the whole repository, the site included.
Biome reads `src/`, `tests/` and the top folder's files, so it leaves `docs-site/` out on purpose; the site's own check covers it.

## The look

The site follows the design skill (`.claude/skills/infinitary-design/`).
`docs-site/src/styles/infinitary.css` imports the skill's `tokens/colors.css` and `tokens/fonts.css` by path and only says which token each of Starlight's own color names takes, so it copies no value a token defines.
Space Grotesk and JetBrains Mono are served by the site itself from the skill's font files.
Dark is the default; light follows the visitor's system or their choice in the theme menu, through the same `data-theme="light"` the tokens answer to.

The header draws the wordmark as `getinfinitary.com` and the design skill draw it (`docs-site/src/components/SiteTitle.astro`): the name in Space Grotesk 500 in the text color (`--fg-1`), never the accent, beside the app icon reduced to its two hexagons, without the icon's dark tile.
The built site's `favicon.svg` is the skill's `assets/app-icon.svg`, copied at build time.

## What a page may say

- Write for someone who has never opened a terminal, in the project's vocabulary (`docs/vocabulary.md` and the design skill's `copy/Vocabulary.prompt.md`), one sentence per line.
- Check every claim against the app and the project page that owns the subject.
- Link to the [public downloads page](https://getinfinitary.com/downloads/) for stable desktop releases, not directly to versioned files or to the private alpha page.
- Offer private TestFlight for Infinitary on iPhone and iPad only by email to `help@getinfinitary.com`, and keep Discord for support, not installation.
- Link to [infinitary-apps](https://github.com/infinitary-labs/infinitary-apps) when referring to the source; it is the development and release repository.
- Make no promise the privacy policy and terms do not make.
- The site loads nothing from another host: no analytics, no web fonts from a service, no embeds.

## Publishing

The site is the Cloudflare Worker `infinitary-docs`, on the same Cloudflare account and zone as `getinfinitary.com`, with `docs.getinfinitary.com` as its only address.
The Worker runs no code of its own: Cloudflare's asset server answers every request from the built `dist/` (`docs-site/wrangler.jsonc`).
An unknown address answers 404 with the site's own not-found page.
There is no `workers.dev` copy, no preview address, and no Workers logs, traces or metrics.

The build writes `dist/_headers`, the security headers every answer carries (`securityHeaders` in `docs-site/astro.config.mjs`).
Its content security policy lets a page run only the site's own script files and the inline scripts the built pages carry, allowed by their hashes, and lets search run its WebAssembly; nothing may load from another host or frame the site.
Every page, the not-found page included, also says `Cache-Control: no-transform`, so Cloudflare's edge passes it on as built: without it, the zone's Web Analytics adds its script to every page a browser asks for.
No-transform also stops Cloudflare compressing an answer, so the pages travel uncompressed, as `getinfinitary.com`'s do, while the files under `/_astro/` and `/pagefind/` leave it out and keep their compression.
The zone's Always Use HTTPS setting moves plain http to https; the Worker runs no code that could, and the preflight stops a publish while the setting is off.

| Item | Value |
| --- | --- |
| Worker | `infinitary-docs` (`docs-site/wrangler.jsonc`) |
| Address | `docs.getinfinitary.com`, the Worker's only custom domain; Cloudflare creates its DNS record and certificate |
| Workflow | `.github/workflows/docs-site-publish.yml` |
| Actions environment and its secrets | `docs-site`, which only `main` may use; `CLOUDFLARE_DOCS_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Concurrency group | `docs-getinfinitary-live`, never cancelled midway, every waiting run kept |

### The key

The docs site has its own Cloudflare API token, separate from the website's, named for the docs site in the Cloudflare dashboard.
It starts with three permissions and gains only what a refusal names:

- Account: Workers Scripts: Edit (publish the Worker and attach its address)
- Zone `getinfinitary.com`: Workers Routes: Edit
- Zone `getinfinitary.com`: Zone: Read

A Cloudflare publishing permission cannot be limited to one Worker, so this key could change the account's other Workers too.
That is why it is a key of its own, lives only in the `docs-site` Actions environment, and reaches only the publish run's steps that need it, on a machine GitHub deletes after the job.
It never appears in code, a command line, a log or a card.
The environment's deployment branch rule allows only `main`, so a workflow on any other branch, a task branch included, cannot read the key; the run's own main-only, operator-only and newest-version checks still apply.
To replace the key, seal the new value with the environment's public key (`GET /repos/{owner}/{repo}/environments/docs-site/secrets/public-key`) and write it as the environment's secret, never as a repository secret.

### Publish

A merge to main publishes the site when it changes `docs-site/`, the design system files the site reads, or the publish workflow.
A manual run on main publishes main's newest version, for example after a failed run was fixed outside those files:

```sh
gh workflow run docs-site-publish.yml --ref main -f commit="$(git rev-parse origin/main)" -f dispatch_id="$(date -u +%Y%m%dT%H%M%SZ)"
```

A successful stable release publishes main's newest version too, because the What's new page is built from the release tags and a new stable tag changes it.
The release run creates its tags with the job's own token, and GitHub starts no run for those tag pushes, so the publish follows the end of the `release` run instead: it publishes only when that run succeeded on main and its jobs' names lead with `Requested stable` (`scripts/ci-job-names.mjs`); an alpha or a rehearsal publishes nothing.
Every run checks out the whole history and every tag for the same reason.

Pull requests and task branches never publish, and only the operator's merges, releases and runs do.
Every run waits its turn in the queue.
When it starts, a merge run whose version is no longer main's newest stops green and publishes nothing only when a newer merge changed the paths that start a merge run, because that merge's own run publishes.
When main moved on only with other files, no run follows, so the merge run publishes: the site it builds is the one main's newest version builds.
A release run or a manual run of anything but main's newest fails, and a manual run on main's newest version replaces it.

The run then installs the site's packages from its lockfile, builds it, runs the site's tests, the site's check and a publish rehearsal, and runs the preflight (`pnpm --dir docs-site preflight`, `docs-site/scripts/cloudflare-docs.mjs`).
The preflight reads the zone and its Always Use HTTPS setting, the Workers on the address and the address's public DNS records, and stops the run when the zone belongs to another account, when Always Use HTTPS is off, when another Worker serves the address, or when a DNS record answers for the address that `infinitary-docs` does not own.
It changes nothing and never prints the key or an id.
The run records the version serving before in its summary, by its version ids and when it went live and never by who published it, publishes with `wrangler deploy`, and then checks the live site.
A failed run reaches the operator through GitHub's own failure email.

### Verify

The live check runs at the end of every publish, and from any computer:

```sh
pnpm --dir docs-site build
node docs-site/scripts/check-live.mjs --origin https://docs.getinfinitary.com
```

It fails unless the home page and an inner page, in English and in each shipped language, answer 200 over https as the site's own pages, each catalog language not shipped yet moves its home and inner addresses to the same English page on the same site, an unknown address answers 404 with the site's own not-found page, plain http moves to https, every answer carries the security headers, no-transform and no cookie, each of those three pages arrives exactly as `dist/` holds it when asked for as a browser asks, and the browser check (`check-site.mjs --origin`) passes at that address, so no page asks another host for anything.
A publish that adds the address, the first one or one after the site was withdrawn, gets its DNS record a few seconds after the upload ends, and a resolver asked before then keeps its "no such name" for the zone's negative time, 30 minutes for `getinfinitary.com`.
So before the live check's first lookup, the run waits up to ten minutes until none of the zone's own name servers still says the address is missing (`docs-site/scripts/wait-for-address.mjs`), asking each of their addresses directly and never the machine's own resolver; an address that already answers passes at once.
Right after such a publish, run `node docs-site/scripts/wait-for-address.mjs` before the live check on your own computer too.
A new address can take a few minutes to get its certificate, so the run then tries the live check for five minutes.
When it still fails, the run's error points at "Restore an earlier version", or at "Withdraw the site" when the run recorded no earlier version.
A publish whose live check fails is not a published site, whatever the upload said; if a step's outcome is unknown, read the Worker's versions and the live site before running anything again.

The same checks run against Cloudflare's own local runtime serving this Worker, with no key:

```sh
pnpm --dir docs-site build
pnpm --dir docs-site exec wrangler dev --port 8799
node docs-site/scripts/check-live.mjs --origin http://127.0.0.1:8799
```

### Restore an earlier version

When a publish misbehaves and an earlier version exists, roll the Worker back to the version the run's summary recorded before it: in the Cloudflare dashboard, Workers & Pages, `infinitary-docs`, Deployments, that version, Rollback.
Then run the live check again.
The next merge that changes the site publishes over a dashboard rollback; to keep the earlier version, merge a revert, which publishes itself.

### Withdraw the site

The first publish has no earlier version to restore.
To take the site offline, remove the `docs.getinfinitary.com` custom domain in Workers & Pages, `infinitary-docs`, Settings, Domains & Routes.
Cloudflare removes the address's DNS record with it, and the Worker stays for a later return.
Confirm with `curl -sSI https://docs.getinfinitary.com/` that the address no longer serves the site.
The next merge that changes the site attaches the address again, so to keep the site offline, also disable `docs-site-publish` in the repository's Actions settings.
