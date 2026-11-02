# Orvelt CLI

Use Orvelt Business from a terminal through the Business API, using browser OAuth, organization selection, and per-resource permissions. MCP is not involved in CLI calls. The CLI discovers operations from the server, so it follows the current API surface and your granted permissions.

Requires **Bun 1.4.2 or later**. This is the standalone source repository for `@orvelt/cli`, maintained by Orvelt Inc. The npm package has not been published yet.

## Run from source

From the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun src/index.ts --help
bun src/index.ts auth login
```

To build and link the `orvelt` command locally:

```sh
bun run build
bun link
orvelt --help
```

## Sign in and approve permissions

```sh
orvelt auth login
```

The browser asks you to sign in, select an organization, and approve read access. You can also approve staying connected between sessions. The CLI uses OAuth authorization code flow with PKCE; there is no API key or bundled client secret.

To request permission to change business data:

```sh
orvelt auth login --write
```

The permissions window still controls what you grant. Organization roles and project-team membership are checked by the server on each operation. A read-only connection does not list write operations.

For a browser that must be opened manually on the same computer:

```sh
orvelt auth login --no-browser
```

The authorization URL is printed to stderr. The browser must be able to reach the CLI's local `127.0.0.1` callback. This is a loopback OAuth flow, not a device-code flow; copying the link to another computer without forwarding the callback port will not complete it. Login waits up to five minutes; change that with `--login-timeout 600` or cancel with Ctrl+C.

## Discover and call operations

```sh
orvelt tools list
orvelt tools list --search questions
orvelt tools list --json
orvelt tools describe projects_list
orvelt call projects_list --schema
orvelt call projects_list --input '{}'
```

Use the exact operation names returned by `tools list`. `tools describe` prints the current input schema, description, access level, and API procedure path. The catalog comes from the OAuth-authenticated API; operation results retain their own domain pagination.

Pass arguments as a JSON object:

```sh
orvelt call <operation> --input @request.json
cat request.json | orvelt call <operation> --input -
```

Input is limited to 1 MiB. Prefer a file or stdin for private data so it does not enter shell history. `--input -` and `--input @-` explicitly read stdin; ordinary commands never wait for implicit piped input. Operation results default to JSON on stdout; diagnostics and authorization URLs go to stderr. `--json` also makes status, discovery, and failures machine-readable, including argument-parsing errors.

### Override individual fields

Use `--set field=JSON` to override top-level fields from `--input`. Values keep their JSON types; strings need JSON quotes. Repeat `--set` or supply several assignments. The last assignment to a field wins; nested objects are replaced, not deep-merged.

```sh
orvelt call <operation> --input @request.json --set limit=25 'cursor=null'
orvelt call <operation> --set 'projectId="project-id"' 'enabled=true'
```

Assignments use exact input field names from `tools describe` or `call <operation> --schema`. Dotted property paths are not supported. The merged input remains limited to 1 MiB. Invalid JSON assignments fail before reading credentials or contacting the API. Prefer `--input @file` or stdin for private values rather than putting them in flags.

### Inspect before executing

```sh
orvelt --usage
orvelt call <operation> --schema
orvelt call <operation> --input @request.json --dry-run
```

`--usage` prints the selected command subtree as JSON, including arguments, options, defaults, environment variable names, and exit codes. For example, `orvelt tools --usage` describes only `tools`, and `orvelt call --usage` works without an operation name. It works offline without credentials and is derived from the argument parser. It does not list remote operations or expose configured environment values. Unknown flags still fail rather than being silently ignored.

`--schema` prints only the operation's current input JSON schema. It requires login and uses the live, permission-filtered catalog. It cannot be combined with request input or `--dry-run`.

Without a snapshot, `--dry-run` uses live discovery: it may discover OAuth metadata, refresh an expired token, and fetch the permitted operation catalog, but never submits the operation itself. It prints `executed: false`, the server, operation metadata, merged input, and the request produced by the real oRPC serializer: method, URL, headers, and JSON or multipart structure. This is an RPC preview, not a reconstructed REST request.

Calls and previews validate input against the catalog's JSON Schema before submitting an operation. Types, required fields, enums, nullable unions, local references, and declared constraints are checked without coercing input, inserting defaults, or stripping fields. Unknown fields are rejected only when the schema explicitly disallows them. Unsupported schemas fail explicitly. The server still owns authorization, transforms, and domain rules absent from that schema.

Known credentials are redacted and file/base64 contents become byte counts; diagnostic text is bounded. Other input may still be private. Previews do not prove that a later execution will succeed.

### Preview offline with an explicit snapshot

```sh
orvelt tools list --json > catalog.json
orvelt call <operation> --catalog @catalog.json --schema
orvelt call <operation> --catalog @catalog.json --input @request.json --dry-run
```

`--catalog` reads an explicitly supplied snapshot and skips credential storage, OAuth discovery, token refresh, and network requests. The preview says `catalogSource: "file"` and `authorization: "not_checked"`. Catalog snapshots can become stale and may contain private schema metadata; store them accordingly. They are accepted only with `--schema` or `--dry-run`, never as authorization for a real call.

### Format and filter results

```sh
orvelt call projects_list --output-format table
orvelt call projects_list --output-format yaml
orvelt call projects_list --output-format toon
orvelt call projects_list --jq '.projects[] | .name' --raw-output
```

`--output-format` accepts `json`, `pretty`, `table`, `yaml`, and `toon`. Renderers use actual response values, not generated model defaults. Tables render all array sections and truncate long cells to 40 characters; use JSON or jq for complete values. JSON remains the default for operations.

`--jq` runs real jq 1.8.2 through the MIT-licensed `jq-wasm` package; it is not a jq-like subset. It overrides the output format. Zero results produce no output; multiple results are emitted separately. `--raw-output` requires `--jq` and writes strings literally, including any terminal controls they contain. Other values stay JSON.

Filters compile before input/credentials/network work. Execution runs in a worker that is terminated on cancellation or the selected timeout. A data-dependent filter failure can occur after an API operation succeeds: inspect current state before retrying a mutation. Formatting and jq do not change the API response's underlying JavaScript numeric precision.

### Shell completion and agent mode

```sh
source <(orvelt completion bash)
source <(orvelt completion zsh)
orvelt completion fish | source
orvelt completion powershell
```

Completion covers local commands, flags, and enum choices without network or credential access. It does not guess or cache permission-filtered remote operation names. Bash execution and Bash/Zsh syntax have been checked locally; Fish and PowerShell scripts are generated but have not been executed on this host.

`--agent-mode` selects machine output and prevents browser launches. Known coding-agent environment variables enable it automatically; `--no-agent-mode` overrides detection. `ORVELT_AGENT_MODE=true` or `false` sets the environment default. Operation output remains JSON unless another format is explicitly selected; agent detection never silently switches to TOON. Explicit `auth login` still requires a person to approve the printed loopback authorization URL.

Machine failures use the existing envelope with additive classification and remediation:

```json
{
  "error": {
    "message": "...",
    "exitCode": 2,
    "type": "validation_error",
    "code": "CLI_VALIDATION",
    "hints": ["..."]
  }
}
```

Authentication, authorization, validation, transport, timeout, and API failures have distinct classifications. Existing exit codes remain unchanged: external interruption is `130`; a command deadline is an operational failure (`1`) whose outcome may be unknown. No automatic retry is added.

```sh
orvelt call projects_list | jq .
orvelt tools list --json > operations.json
```

Calls never launch interactive login. Expired tokens are refreshed when a refresh token is available; otherwise, run `auth login` again. A mutation is submitted once. If a request times out or is interrupted, inspect the current state before retrying: the server may already have applied it.

## Credentials and logout

```sh
orvelt auth status
orvelt auth status --json
orvelt auth logout
```

Credentials are stored in the operating-system credential store through `Bun.secrets`. Status reports whether credentials are stored and makes a read-only server request to verify the current grant. It distinguishes verified connections, connections requiring reauthentication, and connections it could not verify. It never prints tokens.

Logout revokes the refresh token before removing local storage and attempts access-token revocation too. Better Auth uses self-contained access JWTs, which cannot be revoked individually: the CLI reports `accessTokenRevocation: unsupported` and warns that access may remain valid until expiry (about five minutes). To invalidate the grant immediately, disconnect it from **Integrations → Business MCP → Connected apps** in Orvelt Business. If a revocation request fails for another reason, credentials are retained and logout fails. To erase only local credentials, explicitly use `orvelt auth logout --local`; this does not revoke server authorization.

On a headless system without an OS credential store, explicitly opt into file storage:

```sh
export ORVELT_CREDENTIAL_STORE=file
export ORVELT_CONFIG_DIR="$HOME/.config/orvelt-ci"
orvelt auth login --no-browser
```

File storage contains plaintext credentials protected by owner-only permissions. Keep that directory outside source control and shared folders. There is no automatic fallback from a failed keychain to plaintext. Keep the same storage settings for subsequent commands and logout.

Commands sharing a credential entry are serialized to protect refresh-token rotation. If a process is force-killed, a later command may report a stale lock directory. Confirm that no CLI process is using that endpoint, then remove only the empty `.lock` directory named in the error.

## Environments and timeouts

The default OAuth API resource is `https://api.orvelt.com/v1`. Use `--server` or `ORVELT_API_URL` for another environment. Credentials are isolated by endpoint.

```sh
orvelt --server http://127.0.0.1:54100/v1 auth login
orvelt --server http://127.0.0.1:54100/v1 tools list
orvelt call projects_list --timeout 60
```

Remote endpoints require HTTPS. Plain HTTP is accepted only for loopback development. `--timeout` bounds network work and credential-lock wait (30 seconds by default; 1–600 seconds accepted). Each jq compilation/execution phase uses the same timeout bound.

Deployment prerequisite: deploy the shared OAuth API authorization and consent UI together. The API must advertise its exact resource URL and public-client registration endpoint. Existing MCP-specific grants and registrations must reconnect with `business:read` / `business:write`; no automatic permission upgrade or token-audience fallback is performed.

Exit codes: `0` success, `1` operation/authentication failure, `2` invalid command or JSON input, `130` cancellation. Tool failures are written to stderr with their structured result when available.

## Libraries and boundaries

| Option                                          | Fit                                                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Commander](https://github.com/tj/commander.js) | **Selected.** Mature strict argument parsing, nested commands, generated help, environment options, and testable output/exit handling. Bundles with Bun without imposing another project layout. |
| [oclif](https://oclif.io/docs/introduction/)    | Strong plugin and distribution framework. Its project conventions and plugin lifecycle add machinery this CLI does not currently need.                                                           |
| [citty](https://github.com/unjs/citty)          | Lightweight, typed definitions and lazy commands. A good small-CLI choice; Commander provides the explicit error/output hooks and established parser behavior used here.                         |

`oauth4webapi` handles OAuth discovery validation, PKCE, authorization responses, token exchange, and refresh. The oRPC HTTP client calls the Business API directly and serializes file uploads. The CLI contains no MCP dependency. The server's contract-derived OAuth catalog provides operation names and schemas; the API independently authorizes every execution.

### Speakeasy evaluation

On October 31, 2026, we generated a separate Go/Cobra CLI from 63 OAuth-exposed Business operations using the open-source [Speakeasy generator](https://github.com/speakeasy-api/openapi-generation/tree/5d9a4c98764d0f89a216c8f17a121002cb97671e). The comparison export used the shared contract/OpenAPI policy, selected OAuth operations, restricted security to the OAuth bearer alternative, and pointed at loopback rather than production. Generated source and binaries stay outside this workspace; no Speakeasy runtime dependency or generated source is included in this package.

The generated binary compiled successfully. Local checks covered scoped KDL usage, aliases and positional path parameters, typed inputs/body precedence, schemas, request previews, shell completion, output formats/jq, structured failures, credential redaction, and bearer-authenticated GET/POST calls against loopback mocks. Schema/dry-run checks made no mock requests. The generated `auth login` for this bearer-only specification configures a token; it does not replace our browser authorization-code/PKCE flow. No evaluation contacted production or used real credentials.

The first Business-only generation did **not** exercise the generator's full feature set. A second, separately generated capability probe added cursor/page pagination, NDJSON, and a binary response. Executed results:

| Probe               | Observed result                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Cursor `--all`      | Two pages streamed as NDJSON; stopped at a null continuation.                              |
| `--max-pages 1`     | Exactly one request, with no speculative next-page fetch.                                  |
| Repeated cursor     | Failed with `CLI_PROTOCOL` before a third request; earlier stdout remained partial output. |
| Page-number `--all` | Requested pages 1, 2, and 3 exactly.                                                       |
| NDJSON stream       | First output arrived before the server ended the stream.                                   |
| Binary download     | `--output-file` wrote the exact four-byte fixture.                                         |

Those features require transport/response metadata. Their absence from the original generated command tree was not evidence that Speakeasy lacked them.

| Capability                                               | Decision for this CLI                                                                                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine-readable usage                                   | Adopted as scoped offline JSON `--usage`, derived from Commander.                                                                                              |
| Operation input schema                                   | Adopted as `call <operation> --schema`, using the live grant rather than bundled schemas.                                                                      |
| Request preview                                          | Adopted using the real RPC serializer; explicit catalog snapshots allow no-network/no-keychain previews.                                                       |
| Schema validation                                        | Adopted through Zod's JSON-Schema adapter, without silently transforming caller input. All 63 current catalog schemas compiled in a local compatibility check. |
| Typed field input                                        | Adapted as `--set field=JSON`; preserves types without generating a stale per-operation flag tree.                                                             |
| Shell completion                                         | Adopted for four shells, offline for local commands/flags/enum values.                                                                                         |
| Tables, pretty, YAML, TOON, jq/raw output                | Adopted independently, with actual response values and worker-isolated real jq.                                                                                |
| Agent mode and structured parser errors                  | Adopted with explicit opt-out, consistent JSON failures, hints, and unchanged exit codes.                                                                      |
| Binary/credential diagnostic redaction                   | Adopted with byte summaries, control-character sanitization, and bounded diagnostics.                                                                          |
| Named resource commands, aliases, positional path inputs | Still absent. A live command facade needs collision handling and authoritative parameter metadata; `--set` is not equivalent to schema-generated flags.        |
| Path-based multipart uploads                             | Still absent. Current base64 inputs remain limited to 1 MiB and are not equivalent to the API's larger native-file limits.                                     |
| Interactive explorer and missing-field prompts           | Not added: operations stay non-interactive and cannot unexpectedly prompt or open a browser.                                                                   |
| Automatic pagination                                     | Verified in the separate probe, not implemented here. Our catalog needs explicit response/continuation metadata; operation names are not enough.               |
| SSE/JSONL streaming and binary response output           | NDJSON/downloads verified in the separate probe; SSE source-reviewed only. No generic streaming/download path is added to our RPC client.                      |
| Debug/response headers/custom headers                    | Reviewed, not adopted. A safe transport hook must avoid consuming bodies or exposing cookies/tokens; arbitrary headers must not override OAuth.                |
| Retry policy                                             | Reviewed, not adopted. Preserve no-replay mutation behavior; automatic read pagination is a separate concern from retrying writes.                             |
| Native binaries and release installers                   | Worth a separate distribution task; this evaluation does not publish artifacts or add a release pipeline.                                                      |
| Generated auth/config defaults                           | Not adopted: keep browser PKCE, organization consent, rotated-refresh locking, and explicit opt-in to plaintext storage.                                       |

Further generator capabilities were reviewed in source/tests, not executed in the probe:

- **Declarative intents** (`x-speakeasy-cli-commands`): curated names, aliases, categories, examples, presets, schema-bound arguments, route selection, and command-specific hints. Routes select variants of one operation; this is not an arbitrary multi-operation workflow engine.
- **Async/resume**: create once, poll a declared operation with backoff/timeout, resume an existing handle without recreating it, and distinguish success/failure/handoff/unknown states.
- **Artifacts and outcomes**: select content through declared pointers, write base64 media with MIME-derived filenames, return raw responses explicitly, and fail on declared failure states even when HTTP status is successful. URI-only artifact download is not generally supported.
- **Offline enum catalogs**: grouped descriptions and command-specific defaults, distinct from the API's permission-filtered operation catalog.
- **Human interaction**: explicit explorer, missing-field prompts, centralized TTY/agent gating, and a delayed progress indicator. These are useful capabilities, not prerequisites for scripted calls.
- **Distribution and maintenance**: cross-platform GoReleaser artifacts, checksums, optional Homebrew/WinGet/Linux packages, version injection, custom regions, persistent patches/three-way merges, and generated example/dry-run tests. Installer checksum verification and real platform publication must be verified separately; generated configuration is not a shipped release.

Two cautions from the runtime review: generated whole-body input can accept missing fields that individual required flags reject, and typed presentation output can drop fields outside its generated model. We do not treat generation as proof of validation or wire fidelity. Likewise, schema snapshots are never permission grants, and HTTP-success bodies are not heuristically reclassified as failures without a declared outcome contract.

The generator's [licensing policy](https://github.com/speakeasy-api/openapi-generation/blob/5d9a4c98764d0f89a216c8f17a121002cb97671e/LICENSING.md) requires an explicit AGPL output election or commercial authorization. The temporary comparison elected AGPL; the features here are independent implementations, not copied generated code. Generation also reported a nullable-value support warning and pagination annotation hints, so successful generation alone does not establish full transport compatibility.

## Development checks

```sh
bun install --frozen-lockfile --ignore-scripts
bun run lint
bun run format:check
bun run typecheck
bun run test
```

Builds, tests, and future npm releases run from this repository root, independently of the storefront monorepo. GitHub Actions verifies pull requests and `main`; it does not publish to npm.

Unit tests use local protocol fixtures and isolated credential storage. Integration tests run the built executable against the official generic Better Auth OAuth provider, an in-memory adapter, and the oRPC HTTP server. The fixture rejects any MCP request. They exercise signed organization selection/consent, read-only and write grants, declined persistent access, organization isolation, live consent deletion, and logout. They do not use a staging database, grant production access, or mutate a production organization.
