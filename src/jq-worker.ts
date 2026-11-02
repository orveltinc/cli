import type { Jq, JqInput } from 'jq-wasm/inline';

type CompileMessage = { id: number; kind: 'compile'; filter: string };
type RunMessage = { id: number; kind: 'run'; filter: string; value: JqInput; raw: boolean };
type Message = CompileMessage | RunMessage;

let jqPromise: Promise<Jq> | undefined;

async function engine() {
  jqPromise ??= import('jq-wasm/inline').then(({ loadJq }) => loadJq());
  return jqPromise;
}

function reply(id: number, result: unknown) {
  // Web Workers do not take Window.postMessage's targetOrigin argument.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  self.postMessage({ id, ok: true, result });
}

function failure(id: number, message: string) {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  self.postMessage({ id, ok: false, error: message });
}

self.addEventListener('message', async (event: MessageEvent<Message>) => {
  const message = event.data;
  try {
    const jq = await engine();
    if (message.kind === 'compile') {
      // Empty input compiles the actual filter but never evaluates it. Do not
      // wrap caller expressions in another jq program or evaluate sample data.
      const checked = jq.raw('', message.filter);
      if (checked.exitCode !== 0) throw new Error('Invalid jq filter.');
      reply(message.id, null);
      return;
    }

    if (message.raw) {
      // jq-wasm's raw() intentionally trims the final stdout newline. Use
      // jq's JSON result stream and apply jq -r's delimiter per result so
      // multi-output filters and strings containing newlines remain exact.
      reply(message.id, { rawValues: jq.json(JSON.stringify(message.value), message.filter) });
      return;
    }

    // jq.json preserves jq's generator semantics: one value per array entry,
    // including zero-output filters as [].
    reply(message.id, { values: jq.json(JSON.stringify(message.value), message.filter) });
  } catch {
    // Never forward jq's diagnostic text: it can contain data-dependent
    // snippets. The parent only needs a stable, non-sensitive category.
    failure(message.id, message.kind === 'compile' ? 'Invalid jq filter.' : 'jq filter failed.');
  }
});
