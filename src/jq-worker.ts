import type { Jq, JqInput } from 'jq-wasm/inline';
import { parentPort } from 'node:worker_threads';

type CompileMessage = { id: number; kind: 'compile'; filter: string };
type RunMessage = { id: number; kind: 'run'; filter: string; value: JqInput; raw: boolean };
type Message = CompileMessage | RunMessage;

let jqPromise: Promise<Jq> | undefined;

async function engine() {
  jqPromise ??= import('jq-wasm/inline').then(({ loadJq }) => loadJq());
  return jqPromise;
}

function reply(id: number, result: unknown) {
  // Worker postMessage has no Window target origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  parentPort?.postMessage({ id, ok: true, result });
}

function failure(id: number, message: string) {
  // Worker postMessage has no Window target origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  parentPort?.postMessage({ id, ok: false, error: message });
}

parentPort?.on('message', async (message: Message) => {
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
