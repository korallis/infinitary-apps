<h1 align="center">Infinitary</h1>

<p align="center">
  <a href="https://github.com/infinitary-labs/infinitary-apps/actions/workflows/main.yml"
    ><img
      alt="CI"
      src="https://img.shields.io/github/actions/workflow/status/infinitary-labs/infinitary-apps/main.yml?branch=main&style=flat-square&label=ci"
  /></a>
  <a href="https://github.com/infinitary-labs/infinitary-apps/releases/latest"
    ><img
      alt="Release"
      src="https://img.shields.io/github/v/release/infinitary-labs/infinitary-apps?style=flat-square&label=release"
  /></a>
  <a href="https://getinfinitary.com/downloads/"
    ><img
      alt="Platform"
      src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
  /></a>
  <a href="https://x.com/kunchenguid"
    ><img
      alt="X"
      src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square"
  /></a>
  <a href="https://discord.gg/Wsy2NpnZDu"
    ><img
      alt="Discord"
      src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord"
  /></a>
</p>

<h3 align="center">Your own AI studio.</h3>

<p align="center">
  <a href="https://getinfinitary.com"
    ><img
      alt="Infinitary at work: an ask is sent to the first mate, eight crewmates arrive, a finished change comes back as a card with its pictures, a recording and a map, and Merge is pressed."
      src=".github/readme/hero.webp"
      width="800"
  /></a>
</p>

Not another bot, assistant, or factory. A studio that's yours. A place to focus on your taste, craft, and ambition.

Infinitary is a free, open source desktop app for macOS, Linux and Windows. You tell one first mate what you want, by typing or by holding a key and speaking. It plans the work and hands each task to a crewmate, an AI agent that does that one task in its own working copy. The work comes back to you as cards: a decision to make, or a result to see.

- **Tell one first mate. A crew does the work.** - Brought to you by the creator of [firstmate](https://github.com/kunchenguid/firstmate), Infinitary offers a state-of-the-art orchestrator agent that manages your entire crew. Many crewmates work at once, each on its own task.
- **Decisions come to you as cards.** - Your crew brings back intelligently generated cards for efficient decision making. A card carries what changed and the evidence: pictures, recordings, test results.
- **Rigorous engineering.** - Infinitary guides your LLMs to write good code by default, through a rigorous engineering stack. A crewmate runs your project's own tests and checks, a change can get an independent review, and nothing merges until you say so.
- **Your computers, your subscriptions.** - Run your crew on your own computers and the AI subscriptions you already have. Add your other Macs, Linux computers and Windows PCs once; they connect over your own private network.
- **Intelligent model routing.** - Use the full power of every AI model you have. Infinitary gives each task the right model.
- **Automate repetitive work.** - Give your chores to your first mate and watch it get done. It runs the schedules you set, answers research questions on a card and drives a web page while you watch.
- **Make it personal.** - Tell your first mate to make [custom widgets](https://docs.getinfinitary.com/panels/) that turn Infinitary into exactly what you need.

Watch each of these at [getinfinitary.com](https://getinfinitary.com).

## Install

Download Infinitary from the downloads page:

- **[Download for macOS](https://getinfinitary.com/downloads/#macos)**
- **[Download for Linux](https://getinfinitary.com/downloads/#linux)**
- **[Download for Windows (experimental)](https://getinfinitary.com/downloads/#windows)**

The Windows installer is not yet signed with a certificate Microsoft verifies, so Windows warns twice before installing it; the downloads page says what to choose at each warning.

Homebrew is a backup way to install on a Mac, if you would rather use it than the download. A copy from Homebrew updates through Homebrew instead of inside the app.

```sh
brew install --cask infinitary-labs/tap/infinitary
```

What you need:

- A Mac with Apple silicon or Intel, a Linux computer with an x64 chip, or a Windows 11 PC with an x64 chip (experimental).
- At least one AI subscription or API key. For Claude, install Claude Code first; Infinitary uses your copy.
- Ideally a computer that stays on. The first mate works while that computer is awake, and your other devices reach it there.

Infinitary for iPhone and iPad is in private TestFlight; the [downloads page](https://getinfinitary.com/downloads/#ios) says how to ask for an invitation.

## Your own studio

Infinitary is free and open source. It runs on your computer, through the AI subscriptions you already have.

- **Your computer.** The first mate, the crew and your projects live on your computer. Work happens in working copies of your own projects, and your files stay where they are.
- **Your model account.** Infinitary works through the subscriptions you already have. No credits and no metering: your provider's bill is your model bill. Sign in with the Claude, Codex or Grok subscription you already pay for, or connect OpenRouter or another provider with a key. Your work goes straight from your computer to that provider.
- **Your record.** Every task leaves a record: what you asked, what changed, the evidence and what you decided. It stays with you, not with us.

### What leaves your computer

Your work goes to the model provider you chose, and to GitHub or GitLab for a project that lives there. Nothing you write comes to us. An installed build sends anonymous usage events, such as the app opening or first-time setup advancing, with a random install ID. It tells you on first launch, and Settings → General → Sharing turns it off. Whatever that switch says, an installed build's first update check of each day and month also says it is the first, with no ID, so we can count the computers using Infinitary. A build you make from this source sends nothing. The [privacy policy](https://getinfinitary.com/privacy/) and the docs page [What leaves your computer](https://docs.getinfinitary.com/what-leaves-your-computer/) have the rest.

## Docs and community

- [Docs](https://docs.getinfinitary.com/) - how a task goes, cards, projects, automation and panels.
- [Discord](https://discord.gg/Wsy2NpnZDu) - questions, and what people build.
- [Releases](https://github.com/infinitary-labs/infinitary-apps/releases) - what changed in each version.

## Build from source

```sh
git clone https://github.com/infinitary-labs/infinitary-apps.git
cd infinitary-apps
pnpm install
pnpm dev
```

A run from source opens [your own saved data](docs/saved-data-compatibility.md#a-run-from-source), as the installed app does, so quit the installed app first. To run on throwaway data instead, set `INFINITARY_USER_DATA_DIR` to an empty folder. The pages under [`docs/`](docs/README.md) cover [updates from source](docs/alpha.md#updates-from-source) and [local code signing](docs/local-code-signing.md).

## Contributing

Pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the Contributor License Agreement, how a change is checked and how to report a security issue.

## License

Infinitary Labs, Inc. licenses its own code and documentation under the [MIT License](LICENSE). [NOTICE](NOTICE) identifies separately licensed components and credits.
