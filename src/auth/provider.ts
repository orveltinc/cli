import * as oauth from 'oauth4webapi';
import { z } from 'zod';
import { credentialSchema, type Credential, type CredentialStore } from '../credentials';
import { AuthError, checkAbort, loginRequired } from './errors';
import { oauthFetch, type OAuthDiscoveryState } from './network';

/** OAuth-only native public client. No MCP dependency, transport negotiation, or scope step-up. */
export class CliOAuthProvider {
  private verifier?: string;
  private client?: Credential['client'];
  credential?: Credential;
  constructor(
    readonly options: {
      server: string;
      signal: AbortSignal;
      store: CredentialStore;
      discovery: OAuthDiscoveryState;
      redirectUri: string;
      scopes: Credential['scopes'];
      credential?: Credential;
      registeredClient?: Credential['client'];
      interactive?: { state: string; redirect: (url: URL) => Promise<void> };
    },
  ) {
    this.credential = options.credential;
    this.client = options.registeredClient ?? options.credential?.client;
    if (
      (this.credential &&
        (this.credential.issuer !== this.issuer || this.credential.resource !== options.server)) ||
      (this.client && this.client.issuer !== this.issuer)
    ) {
      throw new AuthError(
        'The OAuth issuer or resource changed. Refusing to send saved credentials; run orvelt auth login explicitly.',
        'security',
      );
    }
  }
  get issuer() {
    return this.options.discovery.authorizationServerMetadata.issuer;
  }
  tokens() {
    return this.credential?.tokens;
  }
  private requestOptions() {
    return {
      [oauth.customFetch]: oauthFetch(
        this.options.server,
        this.options.signal,
        this.options.discovery,
      ),
      [oauth.allowInsecureRequests]: new URL(this.options.server).protocol === 'http:',
      additionalParameters: { resource: this.options.server },
    };
  }
  async authorize() {
    if (!this.options.interactive) throw loginRequired();
    const metadata = this.options.discovery.authorizationServerMetadata;
    if (!metadata.code_challenge_methods_supported?.includes('S256'))
      throw new AuthError('The OAuth server must support S256 PKCE.', 'security');
    if (!this.client) {
      if (typeof metadata.registration_endpoint !== 'string')
        throw new AuthError('Public OAuth registration is unavailable.');
      const response = await oauthFetch(
        this.options.server,
        this.options.signal,
        this.options.discovery,
      )(metadata.registration_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_name: 'Orvelt CLI',
          application_type: 'native',
          redirect_uris: [this.options.redirectUri],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope: this.options.scopes.join(' '),
        }),
      });
      const registered = z
        .object({
          client_id: z.string().min(1),
          client_secret: z.never().optional(),
          token_endpoint_auth_method: z.literal('none'),
          scope: z.string().optional(),
        })
        .safeParse(await response.json());
      if (!registered.success)
        throw new AuthError('Expected a registered public OAuth client.', 'security');
      this.client = {
        client_id: registered.data.client_id,
        issuer: this.issuer,
        scope: registered.data.scope ?? this.options.scopes.join(' '),
      };
    }
    if (!metadata.authorization_endpoint)
      throw new AuthError('Missing authorization endpoint.', 'security');
    this.verifier = oauth.generateRandomCodeVerifier();
    const url = new URL(metadata.authorization_endpoint);
    const parameters = new URLSearchParams(url.search);
    for (const [key, value] of Object.entries({
      client_id: this.client.client_id,
      redirect_uri: this.options.redirectUri,
      response_type: 'code',
      scope: this.options.scopes.join(' '),
      state: this.options.interactive.state,
      resource: this.options.server,
      code_challenge: await oauth.calculatePKCECodeChallenge(this.verifier),
      code_challenge_method: 'S256',
      prompt: 'consent',
    }))
      parameters.set(key, value);
    url.search = parameters.toString();
    await this.options.interactive.redirect(url);
  }
  async exchange(params: URLSearchParams) {
    if (!this.client || !this.verifier || !this.options.interactive) throw loginRequired();
    const verifier = this.verifier;
    this.verifier = undefined;
    const metadata = this.options.discovery.authorizationServerMetadata;
    const responseParams = oauth.validateAuthResponse(
      metadata,
      this.client,
      params,
      this.options.interactive.state,
    );
    const response = await oauth.authorizationCodeGrantRequest(
      metadata,
      this.client,
      oauth.None(),
      responseParams,
      this.options.redirectUri,
      verifier,
      this.requestOptions(),
    );
    await this.saveTokens(
      await oauth.processAuthorizationCodeResponse(metadata, this.client, response),
    );
  }
  private async saveTokens(tokens: oauth.TokenEndpointResponse) {
    if (!this.client) throw loginRequired();
    // The CLI deliberately requires an explicit server lifetime. It does not
    // infer one from an unverified JWT or carry forward the old deadline.
    if (tokens.expires_in === undefined || !Number.isFinite(tokens.expires_in))
      throw new AuthError('OAuth token response did not include a valid expires_in.', 'security');
    const scopes =
      tokens.scope?.split(/\s+/).filter(Boolean) ?? this.credential?.scopes ?? this.options.scopes;
    if (
      scopes.some((scope) => !this.options.scopes.includes(scope as Credential['scopes'][number]))
    )
      throw new AuthError(
        'OAuth returned unrequested scopes. Refusing an automatic permission upgrade.',
        'security',
      );
    const credential = credentialSchema.safeParse({
      version: 1,
      server: this.options.server,
      resource: this.options.server,
      issuer: this.issuer,
      redirectUri: this.options.redirectUri,
      client: this.client,
      // RFC 6749: absence of a replacement refresh token retains the current one.
      tokens: {
        ...tokens,
        refresh_token: tokens.refresh_token ?? this.credential?.tokens.refresh_token,
        issuer: this.issuer,
      },
      scopes,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      refreshState: undefined,
    });
    if (!credential.success) throw new AuthError('OAuth returned invalid credentials.', 'security');
    // The server has already issued/rotated these tokens. Persist them even if
    // the command was cancelled, before releasing the caller's credential lock.
    await this.options.store.write(this.options.server, credential.data);
    this.credential = credential.data;
  }
  async refresh() {
    if (!this.client || !this.credential?.tokens.refresh_token) throw loginRequired();
    if (this.credential.refreshState === 'uncertain')
      throw new AuthError(
        'The previous refresh outcome is unknown. Credentials were not reused; run orvelt auth login explicitly.',
        'auth',
      );
    const metadata = this.options.discovery.authorizationServerMetadata;
    const previous = this.credential;
    // This write is inside the caller's cross-process credential lock. If the
    // process dies or the request is cancelled after dispatch, the marker
    // prevents another process from replaying the old rotated token.
    await this.options.store.write(
      this.options.server,
      { ...previous, refreshState: 'uncertain' },
      this.options.signal,
    );
    checkAbort(this.options.signal);
    const response = await oauth.refreshTokenGrantRequest(
      metadata,
      this.client,
      oauth.None(),
      this.credential.tokens.refresh_token,
      this.requestOptions(),
    );
    let tokens: oauth.TokenEndpointResponse;
    try {
      tokens = await oauth.processRefreshTokenResponse(metadata, this.client, response);
    } catch (error) {
      // oauth4webapi's ResponseBodyError means it validated a structured
      // OAuth error response (only 4xx JSON bodies qualify). HTTP 5xx,
      // malformed bodies, and processing failures remain uncertain because a
      // proxy may have hidden a committed rotation.
      if (error instanceof oauth.ResponseBodyError) {
        // A definite rejection did not rotate the token. Finish restoring the
        // previous entry under the lock, independently of command cancellation.
        await this.options.store.write(this.options.server, previous);
        this.credential = previous;
      }
      throw error;
    }
    await this.saveTokens(tokens);
  }
}
