# The usage report

Infinitary reports every provider's usage from its own ledger to the collectors a company or a person points it at, so a team's monitoring shows Infinitary's work instead of $0.
Each destination gets one format, and nothing is ever sent in two formats.

| Piece | Where |
| --- | --- |
| The destination shape and the sender | `UsageReportDestination`, `UsageReporter` (`src/core/usageReport/usageReporter.ts`) |
| The company's Claude Code setup as a destination | `companyDestination`, `companyUsageDestinations` (`src/core/usageReport/companyDestination.ts`) |
| The two formats, from ledger rows and heard turns | `claudeCodeBodies`, `standardBodies`, `callSpan` (`src/core/usageReport/usageReportFormats.ts`) |
| The rows it reads | what `UsageStore.record` answers it wrote (`docs/usage.md`, "What the ledger records") |
| Where it is built and hears turns | `homeUsage` (`src/core/storage/homeUsage.ts`), `EventSeam.attachUsageReport` (`src/core/eventSeam.ts`) |
| Its place on the outbound list | `docs/architecture.md` §1, "Usage report destinations" |

## Destinations

A destination is one place the report goes, with exactly one format, the full OTLP/HTTP address of each signal it takes, the headers it asks for per batch, and its own resource attributes (who and which team, as the company set them).
Its source owns where it comes from and which format it was saved with: a company's Claude Code reporting setup defaults to Claude Code's format, a connection the person adds to the standard one.
With no destination, the reporter keeps nothing and sends nothing.

The company's Claude Code reporting setup (`docs/usage.md`, "A company's Claude Code setup") is one destination in Claude Code's format.
It takes the setup's per-signal addresses and certificate files, its headers (the header command's included, through `companyHeaders`), its `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_SERVICE_NAME`, and the email of the person's own Claude Code login (`claudeLoginEmail`).
An administrator's managed setup comes first (`readManagedReporting`): Claude's own client reports there itself, and every other provider's calls go there too, from the managed tier's reporting keys laid over the launch environment and its own header command; a managed policy helper, whose answer is never known here, leaves it out.
Otherwise the person's own setup is the destination only where the receiver passes Claude's records on to it.
The setup is read again at most once a minute, when the reporter asks.
Settings → Usage names this destination's host as where the crew's usage goes; where the setup leaves it none, as over gRPC, its line names the setup's host for Claude work only, which Claude's own client or the receiver still reports there (`reporting`).

## The two formats

Both are written from the same ledger rows, so every number equals Settings → Usage.

- **Claude Code's format**, for a company whose panels read Claude Code's own reports.
  Claude work is Claude's own records, passed on unchanged; the reporter never repeats a row whose provider is the Claude client (`anthropic-claude`), so nothing is counted twice.
  Every other provider's calls go under Claude Code's names: `claude_code.cost.usage` in US dollars, `claude_code.token.usage` by `type` (`input`, `output`, `cacheRead`, `cacheCreation`), and a `claude_code.api_request` log event with the model, the four token kinds and `cost_usd`.
  Each carries a `provider` attribute, so a panel that checks spend against Anthropic's bill filters by it, and `user.email` from the person's own Claude Code login when there is one, as Claude's records do, so a per-person panel counts that person's other work too.
- **The standard format**, OpenTelemetry's conventions for AI calls at version 1.37.0, pinned on every scope's schema address because those names are still marked in development.
  All work, Claude's included: `gen_ai.client.token.usage` as a histogram by `gen_ai.token.type`, provider and model, and `infinitary.cost.usage` in estimated US dollars, since the conventions define no cost.
  The conventions name only `input` and `output` token types; cache reads and writes go as `cache_read` and `cache_creation` rather than folding into input, because a provider's input count may or may not include them.
  Traces hold one `invoke_agent` span per first mate or crewmate turn, a `chat {model}` span per ledger row, a child of its turn or a trace of its own for a call outside any turn, such as a reply check, and an `execute_tool {name}` child span per tool run; context shortening and provider retries are not tool runs.

Every metric, event, model call span and turn span is grouped by `infinitary.role` (`firstmate`, `crewmate` or `other`) and the task's saved kind of work (`infinitary.work_kind`); a tool run's span carries the tool's name and call id.
Nothing carries a task title, project name, prompt or output.
`service.name` is `infinitary` unless the destination's own attributes name another.
Metrics are delta sums: each batch says only what it adds.

A session ends a step per model call, so a turn is not one session step: it opens at the session's first words or tool run and ends where its owner settles it, when the first mate is no longer busy or a crewmate's task is no longer running; a crewmate step that failed marks its turn failed, while the first mate's failed steps are not broadcast, so its turn is never marked failed.
The ledger keeps no call timing, so a model call's span runs from the previous call in its turn, or the turn's start, to the moment the call was recorded.
A turn that never ends, such as a session that crashed, is forgotten after six hours; a task that finishes ends its open turn.

## Sending

The reporter runs on the computer that keeps the ledger, whichever computer the session ran on.
A batch goes five seconds after its first row or span, as Claude's client batches its own reports, and once more as the app stops.
Each signal is one OTLP/HTTP JSON request with the destination's headers, over connections kept open between batches; redirects are not followed and a request gives up after ten seconds.
A secure signal goes the way Claude's forward sends to a company collector (`collectorAgent`, `postOtlpHttp`; `docs/usage.md`, "Certificates"): with the certificate files its source names for it, or else checked against the computer's trusted list, so a collector on a company's own certificate authority, or one that takes only client certificates, gets every provider's work as it gets Claude's; a relative file path resolves against the folder the app runs in.
The kept connections are made again when a certificate file changes, even at the same path, so a certificate renewed in place is sent from the next batch; the old connections close once idle, so a batch in flight on one finishes.
A refused or unreachable destination drops that batch with one log line naming its host and the HTTP status or failure (`secure-connection` where the connection could not be made secure), never a header value; recording a row never waits on the network.
A signal a setup sends over gRPC takes no JSON request, so its source offers no address for it; a signal set to `http/protobuf` takes the JSON body at the same address, which the OpenTelemetry Collector accepts.
