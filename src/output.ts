import type { JqInput } from 'jq-wasm/inline';
import { InputError } from './input';
import { compileJq, runJq, type JqWorker } from './jq';
import { terminalText } from './diagnostics';

export type OutputFormat = 'json' | 'pretty' | 'table' | 'yaml' | 'toon';
export type OutputOptions = {
  format?: OutputFormat;
  jq?: string;
  rawOutput?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const MAX_TABLE_WIDTH = 40;

function safeValue(value: unknown): unknown {
  if (typeof value === 'string') return terminalText(value);
  if (Array.isArray(value)) return value.map(safeValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [terminalText(key), safeValue(item)]),
    );
  return value;
}

function compact(value: unknown) {
  return JSON.stringify(safeValue(value));
}

function scalar(value: unknown) {
  if (typeof value === 'string') return terminalText(value);
  return compact(value) ?? 'null';
}

function pretty(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (
      Object.entries(value)
        .map(([key, item]) => `${terminalText(key)}: ${scalar(item)}`)
        .join('\n') + '\n'
    );
  }
  return `${JSON.stringify(safeValue(value), null, 2)}\n`;
}

function tableRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value))
    return value.map((item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : { value: item },
    );
  if (value && typeof value === 'object') return [value as Record<string, unknown>];
  return [{ value }];
}

function bounded(value: string, width: number) {
  if (value.length <= width) return value.padEnd(width);
  if (width <= 1) return '…'.slice(0, width).padEnd(width);
  return `${value.slice(0, width - 1)}…`;
}

function tableCell(row: Record<string, unknown>, key: string) {
  return Object.hasOwn(row, key) ? scalar(row[key]) : '';
}

function table(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value);
    const arrays = entries.filter(([, item]) => Array.isArray(item));
    if (arrays.length) {
      const other = Object.fromEntries(entries.filter(([, item]) => !Array.isArray(item)));
      return (
        arrays.map(([name, rows]) => `${terminalText(name)}\n${table(rows)}`).join('\n') +
        (Object.keys(other).length ? `\n${table(other)}` : '')
      );
    }
  }
  const rows = tableRows(value);
  if (rows.length === 0) return '(empty)\n';
  const columns: string[] = [];
  for (const row of rows)
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  const displayColumns = columns.map(terminalText);
  const widths = columns.map((key, index) => {
    let width = (displayColumns[index] ?? '').length;
    for (const row of rows) width = Math.max(width, tableCell(row, key).length);
    return Math.min(MAX_TABLE_WIDTH, width);
  });
  const line = (row: Record<string, unknown> | undefined) =>
    columns
      .map((key, index) =>
        bounded(row ? tableCell(row, key) : (displayColumns[index] ?? ''), widths[index] ?? 1),
      )
      .join('  ')
      .trimEnd();
  return `${line(undefined)}\n${widths.map((width) => '-'.repeat(width)).join('  ')}\n${rows.map((row) => line(row)).join('\n')}\n`;
}

async function formatter(format: OutputFormat, value: unknown) {
  if (format === 'json') return `${JSON.stringify(value, null, 2)}\n`;
  if (format === 'pretty') return pretty(value);
  if (format === 'table') return table(value);
  if (format === 'yaml') {
    const { stringify } = await import('yaml');
    return stringify(value);
  }
  const { encode } = await import('@toon-format/toon');
  return `${encode(value)}\n`;
}

export async function prepareOutput(
  options: OutputOptions,
  write: (text: string) => void,
): Promise<{ write(value: unknown): Promise<void>; close(): void }> {
  const format = options.format ?? 'json';
  if (options.rawOutput && !options.jq) throw new InputError('--raw-output requires --jq.');
  let jqWorker: JqWorker | undefined;
  if (options.jq) jqWorker = await compileJq(options.jq, options);

  return {
    async write(value) {
      if (jqWorker) {
        let result;
        try {
          result = await runJq(
            jqWorker,
            options.jq ?? '.',
            value as JqInput,
            options.rawOutput === true,
          );
        } catch (error) {
          jqWorker.close();
          jqWorker = undefined;
          throw error;
        }
        if (result && 'rawValues' in result) {
          for (const item of result.rawValues) {
            const text = typeof item === 'string' ? item : JSON.stringify(item);
            write(`${text}\n`);
          }
          return;
        }
        for (const item of result?.values ?? []) write(`${JSON.stringify(item, null, 2)}\n`);
        return;
      }
      write(await formatter(format, value));
    },
    close() {
      jqWorker?.close();
      jqWorker = undefined;
    },
  };
}
