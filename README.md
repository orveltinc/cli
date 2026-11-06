# Orvelt CLI

Manage Orvelt Business from your terminal. Sign in with your browser, choose an organization, and discover the API operations your account can use.

This is the standalone source repository for `@orvelt/cli`, maintained by Orvelt Inc. The CLI is distributed under the [Apache License 2.0](LICENSE).

Requires **Node.js 20.19 or later**, or **Bun 1.3.3 or later**. Prefer a maintained Node.js LTS release. The repository's development scripts use Bun; the built CLI does not require it.

## Install

Choose your package manager.

| Package manager | Install or run                     |
| --------------- | ---------------------------------- |
| npm             | `npm install --global @orvelt/cli` |
| pnpm            | `pnpm add --global @orvelt/cli`    |
| Yarn 2+         | `yarn dlx @orvelt/cli --help`      |
| Yarn Classic    | `yarn global add @orvelt/cli`      |
| Bun             | `bunx --bun @orvelt/cli --help`    |

For a one-off Node invocation, use `npx @orvelt/cli --help` or `pnpm dlx @orvelt/cli --help`. Replace `--help` with the command you want to run. Bun-only installations should use `bunx --bun` to override the executable's Node shebang.

## Quick start

```sh
orvelt auth login
orvelt auth status
orvelt tools list
orvelt call projects_list
```

Only `auth login` opens an authentication flow. Other commands never prompt you to sign in or launch a browser.

## Sign in and approve permissions

```sh
orvelt auth login
```

The browser asks you to sign in, select an organization, and approve read access. You can also approve staying connected between sessions. The CLI uses OAuth authorization code flow with PKCE; there is no API key or bundled client secret.

To request permission to change business data:

```sh
orvelt auth login --write
```

In the permissions window, select **Write** for each resource you want to change before approving. `--write` requests that option; it does not select it for you. Organization roles and project-team membership are checked by the server on each operation. A read-only connection does not list write operations.

For a browser that must be opened manually on the same computer:

```sh
orvelt auth login --no-browser
```

The authorization URL is printed to stderr. The browser must be able to reach the CLI's local `127.0.0.1` callback. This is a loopback OAuth flow, not a device-code flow; copying the link to another computer without forwarding the callback port will not complete it. Login waits up to five minutes; change that with `--login-timeout 600` or cancel with Ctrl+C.

Check the saved connection and verify the live grant:

```sh
orvelt auth status
orvelt auth status --json
```

Sign out from the current server:

```sh
orvelt auth logout
```

Logout revokes the refresh token before removing local credentials. An access token may remain valid until expiry; see [credentials and logout](#credentials-and-logout). If revocation cannot complete, credentials are retained so you can retry. To remove only this machine's credentials, use `orvelt auth logout --local`.

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

Credentials use the operating-system credential store through a native binding: macOS Keychain, Windows Credential Manager, or Linux Secret Service. Linux needs a running Secret Service. macOS may ask permission when a different Node or Bun executable accesses a saved entry. Status reports whether credentials are stored and makes a read-only server request to verify the current grant. It distinguishes verified connections, connections requiring reauthentication, and connections it could not verify. It never prints tokens.

Logout revokes the refresh token before removing local storage and attempts access-token revocation too. Better Auth uses self-contained access JWTs, which cannot be revoked individually: the CLI reports `accessTokenRevocation: unsupported` and warns that access may remain valid until expiry (about five minutes). To invalidate the grant immediately, disconnect it from **Integrations → Business MCP → Connected apps** in Orvelt Business. If a revocation request fails for another reason, credentials are retained and logout fails. To erase only local credentials, explicitly use `orvelt auth logout --local`; this does not revoke server authorization.

On a headless system without an OS credential store, explicitly opt into file storage:

```sh
export ORVELT_CREDENTIAL_STORE=file
export ORVELT_CONFIG_DIR="$HOME/.config/orvelt-ci"
orvelt auth login --no-browser
```

File storage contains plaintext credentials protected by owner-only permissions on macOS and Linux. It is unavailable on Windows because the CLI does not verify Windows file ACLs; use the OS credential store there. Keep that directory outside source control and shared folders. There is no automatic fallback from a failed keychain to plaintext. Keep the same storage settings for subsequent commands and logout.

Commands sharing a credential entry are serialized to protect refresh-token rotation. A credential write or deletion already in progress must finish before cancellation releases its lock. If a process is force-killed, a later command may report a stale lock directory. Confirm that no CLI process is using that endpoint, then remove only the empty `.lock` directory named in the error.

## Environments and timeouts

The default OAuth API resource is `https://api.orvelt.com/v1`. Use `--server` or `ORVELT_API_URL` for another environment. Credentials are isolated by endpoint.

```sh
orvelt --server http://127.0.0.1:54100/v1 auth login
orvelt --server http://127.0.0.1:54100/v1 tools list
orvelt call projects_list --timeout 60
```

Remote endpoints require HTTPS. Plain HTTP is accepted only for loopback development. `--timeout` bounds network work and credential-lock wait (30 seconds by default; 1–600 seconds accepted). Each jq compilation/execution phase uses the same timeout bound.

Exit codes: `0` success, `1` operation/authentication failure, `2` invalid command or JSON input, `130` cancellation. Tool failures are written to stderr with their structured result when available.

## Development

Building and running the repository's tests uses Bun. Consumers of the built package do not need Bun.

From the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun pm pack --ignore-scripts --filename orvelt-cli.tgz
npm install --global ./orvelt-cli.tgz
orvelt --help
```

Use `pnpm add --global ./orvelt-cli.tgz` or `yarn global add "file:$PWD/orvelt-cli.tgz"` (Yarn Classic) instead of npm if preferred. With Bun alone, run `bun dist/index.js --help`.

Run checks from the repository root:

```sh
bun run test
bun run typecheck
bun run lint
bun run format:check
```

Check isolated npm, pnpm, Yarn, and Bun installations with `bun run test:compatibility`. Set `ORVELT_SMOKE_NODE_BINARIES` to a comma-separated list of absolute Node executable paths to test multiple runtimes. These checks use disposable file storage and do not access your keychain.

To run the OAuth integration suite against a particular Node executable:

```sh
ORVELT_CLI_TEST_RUNTIME=/path/to/node bun run test-integration
```

Unit tests use local protocol fixtures and isolated credential storage. Integration tests run the built executable against the official generic Better Auth OAuth provider, an in-memory adapter, and the oRPC HTTP server. The fixture rejects any MCP request. They exercise signed organization selection/consent, read-only and write grants, declined persistent access, organization isolation, live consent deletion, and logout. They do not use a staging database, grant production access, or mutate a production organization.

Authentication follows the explicit [`gh auth`](https://cli.github.com/manual/gh_auth) command structure and [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252): an external browser, authorization code with PKCE, and a loopback callback. `oauth4webapi` validates the OAuth exchange; API calls use oRPC directly.
