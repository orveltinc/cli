import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { jwt, organization, testUtils } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import { RPCHandler } from '@orpc/server/fetch';
import { ORPCError, os } from '@orpc/server';
import { z } from 'zod';

async function notReady() {
  return new Response(null, { status: 503 });
}

async function redirect(response: Response): Promise<URL> {
  const location = response.headers.get('location');
  if (location) return new URL(location);
  const data = (await response.json()) as { url?: string; redirect_uri?: string } | null;
  const target = data?.url ?? data?.redirect_uri;
  if (!target) throw new Error(`Expected OAuth redirect (HTTP ${response.status}).`);
  return new URL(target);
}

/** Real OAuth provider + MCP SDK, isolated in memory. No application database or real account. */
export async function createOAuthAuthority() {
  let handle: (request: Request) => Promise<Response> = notReady;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => handle(request) });
  const origin = `http://127.0.0.1:${server.port}`;
  const resource = `${origin}/v1`;
  const issuer = `${origin}/biz-auth`;
  const directory = await mkdtemp(join(tmpdir(), 'orvelt-real-oauth-'));
  const auth = betterAuth({
    baseURL: origin,
    basePath: '/biz-auth',
    secret: randomBytes(32).toString('hex'),
    database: memoryAdapter(
      Object.fromEntries(
        [
          'user',
          'session',
          'account',
          'verification',
          'jwks',
          'organization',
          'member',
          'invitation',
          'team',
          'teamMember',
          'oauthClient',
          'oauthClientResource',
          'oauthResource',
          'oauthConsent',
          'oauthAccessToken',
          'oauthRefreshToken',
        ].map((model) => [model, []]),
      ),
    ),
    logger: { disabled: true },
    plugins: [
      jwt(),
      organization(),
      oauthProvider({
        resources: [resource],
        clientRegistrationDefaultResources: [resource],
        refreshTokenReuseInterval: 0,
        loginPage: `${origin}/sign-in`,
        consentPage: `${origin}/oauth/consent`,
        scopes: ['business:read', 'business:write', 'offline_access'],
        grantTypes: ['authorization_code', 'refresh_token'],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        accessTokenExpiresIn: 300,
        selectAccount: {
          page: `${origin}/oauth/select-organization`,
          shouldRedirect: async () => true,
        },
        postLogin: {
          page: `${origin}/oauth/select-organization`,
          shouldRedirect: async () => false,
          consentReferenceId: ({ session }) => {
            if (typeof session.activeOrganizationId !== 'string' || !session.activeOrganizationId)
              throw new Error('Select an organization.');
            return session.activeOrganizationId;
          },
        },
        extensions: [
          { claims: { accessToken: ({ referenceId }) => ({ fixtureOrganization: referenceId }) } },
        ],
        clientPrivileges: async () => false,
        resourcePrivileges: async () => false,
      }),
      testUtils(),
    ],
  });
  const authContext = await auth.$context;
  const user = authContext.test.createUser({
    email: 'cli-fixture@example.test',
    emailVerified: true,
  });
  await authContext.test.saveUser(user);
  const headers = await authContext.test.getAuthHeaders({ userId: user.id });
  const organizations = [];
  for (const name of ['a', 'b'])
    organizations.push(
      await auth.api.createOrganization({
        headers,
        body: { name: `CLI fixture ${name}`, slug: `cli-fixture-${name}` },
      }),
    );
  const orgA = organizations[0]?.id;
  const orgB = organizations[1]?.id;
  if (!orgA || !orgB) throw new Error('Fixture organizations were not created.');
  const state = {
    organizationId: orgA,
    write: false,
    offline: true,
    accept: true,
    writes: [] as string[],
    failRevocation: false,
    tokenRequests: 0,
    revocations: [] as Array<{ status: number; error: unknown }>,
    selected: [] as string[],
  };
  const verifier = oauthProviderResourceClient(auth).getActions();
  const authed = os.$context<{ claims: Record<string, unknown> }>();
  const operations = [
    {
      name: 'projects_list',
      path: ['projects', 'list'],
      title: 'List projects',
      access: 'read',
      inputSchema: { type: 'object' },
    },
    {
      name: 'project_update',
      path: ['project', 'update'],
      title: 'Update project',
      access: 'write',
      inputSchema: {
        type: 'object',
        properties: { organizationId: { type: 'string' } },
        required: ['organizationId'],
      },
    },
  ];
  const rpc = new RPCHandler({
    oauthConnections: {
      operations: authed.handler(({ context }) => ({
        operations: operations.filter(
          (op) => op.access === 'read' || String(context.claims.scope).includes('business:write'),
        ),
      })),
    },
    projects: {
      list: authed.handler(({ context }) => ({
        projects: [
          {
            id: 'project-' + context.claims.fixtureOrganization,
            organizationId: context.claims.fixtureOrganization,
          },
        ],
      })),
    },
    project: {
      update: authed
        .input(z.object({ organizationId: z.string() }))
        .handler(({ context, input }) => {
          if (
            !String(context.claims.scope).split(' ').includes('business:write') ||
            input.organizationId !== context.claims.fixtureOrganization
          )
            throw new ORPCError('FORBIDDEN');
          state.writes.push(input.organizationId);
          return { updated: true, organizationId: input.organizationId };
        }),
    },
  });
  async function protectedHandler(request: Request) {
    const claims = await verifier.verifyAccessTokenRequest(request, {
      verifyOptions: { issuer, audience: resource },
      requiredScopes: ['business:read'],
    });
    const grant = await authContext.adapter.findOne<{ scopes: string[] }>({
      model: 'oauthConsent',
      where: [
        { field: 'clientId', value: String(claims.client_id) },
        { field: 'userId', value: user.id },
        { field: 'referenceId', value: String(claims.fixtureOrganization) },
      ],
    });
    if (
      !grant ||
      !String(claims.scope)
        .split(' ')
        .every((scope) => grant.scopes.includes(scope))
    )
      return new Response(null, { status: 401 });
    const result = await rpc.handle(request, { prefix: '/rpc/v2/business', context: { claims } });
    return result.response ?? new Response(null, { status: 404 });
  }

  handle = async (request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/rpc/v2/business/')) return protectedHandler(request);
    if (path === '/mcp') throw new Error('The CLI must not contact MCP.');
    if (path === '/.well-known/oauth-protected-resource/v1')
      return Response.json({ resource, authorization_servers: [issuer] });
    if (path === '/biz-auth/oauth2/token') state.tokenRequests++;
    if (path === '/biz-auth/oauth2/revoke' && state.failRevocation)
      return new Response(null, { status: 500 });
    const response = await auth.handler(request);
    if (path === '/biz-auth/oauth2/revoke') {
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => undefined);
      state.revocations.push({ status: response.status, error: body });
    }
    return response;
  };

  const authenticatedHeaders = () => {
    const result = new Headers(headers);
    result.set('content-type', 'application/json');
    result.set('origin', origin);
    return result;
  };
  /** Test-only browser driver: uses official authenticated selection/consent endpoints. */
  async function consent(authorizationUrl: URL) {
    let target = await redirect(await fetch(authorizationUrl, { headers, redirect: 'manual' }));
    if (target.pathname !== '/oauth/select-organization')
      throw new Error('Expected organization picker.');
    await auth.api.setActiveOrganization({
      headers,
      body: { organizationId: state.organizationId },
    });
    state.selected.push(state.organizationId);
    target = await redirect(
      await fetch(`${issuer}/oauth2/continue`, {
        method: 'POST',
        headers: authenticatedHeaders(),
        redirect: 'manual',
        body: JSON.stringify({ selected: true, oauth_query: target.searchParams.toString() }),
      }),
    );
    if (target.pathname !== '/oauth/consent')
      throw new Error('Expected signed permissions window.');
    const grantedScopes = [
      'business:read',
      ...(state.write ? ['business:write'] : []),
      ...(state.offline ? ['offline_access'] : []),
    ];
    target = await redirect(
      await fetch(`${issuer}/oauth2/consent`, {
        method: 'POST',
        headers: authenticatedHeaders(),
        redirect: 'manual',
        body: JSON.stringify({
          accept: state.accept,
          scope: grantedScopes.join(' '),
          oauth_query: target.searchParams.toString(),
        }),
      }),
    );
    return fetch(target, { redirect: 'manual' });
  }
  return {
    state,
    orgA,
    orgB,
    resource,
    directory,
    consent,
    async disconnect() {
      const consents = await auth.api.getOAuthConsents({ headers });
      for (const grant of consents)
        await auth.api.deleteOAuthConsent({ headers, body: { id: grant.id } });
    },
    async close() {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
