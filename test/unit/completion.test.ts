import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { Command, Option } from 'commander';
import { completionScript, complete } from '../../src/completion';

function tree() {
  const program = new Command('orvelt')
    .option('--server <url>', 'server')
    .option('--verbose')
    .option('--agent-mode [mode]', 'agent mode');
  program.addOption(new Option('--format <format>', 'format').choices(['json', 'yaml']));
  const projects = program.command('projects').alias('p').description('Projects');
  projects.command('list').description('List projects');
  projects.command('get <id>').description('Get project');
  projects.addCommand(new Command('__complete [words...]'), { hidden: true });
  return program;
}

describe('offline completion', () => {
  test('completes commands, aliases, and inherited flags', () => {
    const program = tree();
    expect(complete(program, [''])).toEqual(
      expect.arrayContaining([
        { value: 'projects', description: 'Projects' },
        { value: 'p', description: 'Projects' },
        { value: '--server', description: 'server' },
        { value: '--verbose', description: '' },
        { value: '--format', description: 'format' },
      ]),
    );
    expect(complete(program, ['p', ''])).toEqual(
      expect.arrayContaining([{ value: 'list', description: 'List projects' }]),
    );
    expect(complete(program, [''])).not.toEqual(
      expect.arrayContaining([{ value: '__complete', description: '' }]),
    );
    expect(complete(program, ['pro'])).toEqual([{ value: 'projects', description: 'Projects' }]);
  });

  test('skips option values and completes enum values', () => {
    const program = tree();
    expect(complete(program, ['--server', 'https://example.test', ''])).toEqual(
      expect.arrayContaining([{ value: 'projects', description: 'Projects' }]),
    );
    expect(complete(program, ['--format', ''])).toEqual([
      { value: 'json', description: 'format' },
      { value: 'yaml', description: 'format' },
    ]);
    expect(complete(program, ['--format=json'])).toEqual([
      { value: '--format=json', description: 'format' },
    ]);
    expect(complete(program, ['--agent-mode', '--json', ''])).toEqual(
      expect.arrayContaining([{ value: 'projects', description: 'Projects' }]),
    );
  });

  test('stops at a literal terminator, except when it is a required value', () => {
    const program = tree();
    expect(complete(program, ['--', ''])).toEqual([]);
    expect(complete(program, ['--', 'projects', ''])).toEqual([]);
    expect(complete(program, ['--server', '--', ''])).toEqual(
      expect.arrayContaining([{ value: 'projects', description: 'Projects' }]),
    );
  });

  test('rejects control characters and never evaluates input', () => {
    expect(() => complete(tree(), ['$(touch compromised)'])).not.toThrow();
    expect(() => complete(tree(), ['bad\u0000token'])).toThrow('unsafe characters');
  });

  test('bash completion uses only tokens through the cursor', () => {
    const script = completionScript(tree(), 'bash');
    const output = execFileSync(
      'bash',
      [
        '-c',
        `${script}\norvelt() { if [ "$#" -ne 4 ] || [ "$1" != '__complete' ] || [ "$2" != '--' ] || [ "$3" != 'projects' ] || [ "$4" != 'li' ]; then return 42; fi; printf 'list\\tList projects\\n'; }\nCOMP_WORDS=(orvelt projects li later); COMP_CWORD=2; _orvelt_complete; printf '%s\\n' "\${COMPREPLY[@]}"`,
      ],
      { encoding: 'utf8' },
    );
    expect(output).toBe('list\n');
  });

  test('validates bash and zsh syntax when installed', () => {
    for (const shell of ['bash', 'zsh'] as const) {
      try {
        execFileSync(shell, ['-n'], {
          input: completionScript(tree(), shell),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (error as { code?: string }).code === 'ENOENT'
        )
          continue;
        throw error;
      }
    }
  });
});
