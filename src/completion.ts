import type { Command, Option } from 'commander';

export type CompletionShell = 'bash' | 'zsh' | 'fish' | 'powershell';
export type Completion = { value: string; description: string };

const shells = new Set<CompletionShell>(['bash', 'zsh', 'fish', 'powershell']);

function rejectUnsafeWords(words: string[]) {
  for (const word of words) {
    if (
      word.length > 4096 ||
      Array.from(word).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      })
    )
      throw new Error('Completion arguments contain unsafe characters.');
  }
}

function commandName(command: Command) {
  return command.name();
}

function isHiddenCommand(command: Command) {
  return (
    command.name() === '__complete' || Boolean((command as Command & { hidden?: boolean }).hidden)
  );
}

function visibleCommands(command: Command) {
  return command
    .createHelp()
    .visibleCommands(command)
    .filter((child) => !isHiddenCommand(child));
}

function allOptions(command: Command): Option[] {
  const result: Option[] = [];
  for (let current: Command | null = command; current; current = current.parent) {
    for (const option of current.createHelp().visibleOptions(current)) {
      if (!option.hidden && !result.some((item) => item.flags === option.flags))
        result.push(option);
    }
  }
  return result;
}

function optionNames(option: Option) {
  return [option.long, option.short].filter((name): name is string => Boolean(name));
}

function findOption(command: Command, token: string) {
  const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
  return allOptions(command).find((option) => optionNames(option).includes(name));
}

function needsValue(option: Option) {
  return option.required || option.optional;
}

function choices(option: Option, prefix: string, optionPrefix = ''): Completion[] {
  return (option.argChoices ?? [])
    .filter((choice) => typeof choice === 'string' || typeof choice === 'number')
    .map((choice) => String(choice))
    .filter((value) => value.startsWith(prefix))
    .map((value) => ({ value: `${optionPrefix}${value}`, description: option.description }));
}

function optionCompletions(command: Command, prefix: string): Completion[] {
  const result: Completion[] = [];
  for (const option of allOptions(command)) {
    for (const name of optionNames(option)) {
      if (name.startsWith(prefix) && !result.some((item) => item.value === name))
        result.push({ value: name, description: option.description });
    }
  }
  return result;
}

function commandCompletions(command: Command, prefix: string): Completion[] {
  return visibleCommands(command)
    .flatMap((child) => [child.name(), ...child.aliases()])
    .filter((value, index, values) => values.indexOf(value) === index && value.startsWith(prefix))
    .map((value) => {
      const child = visibleCommands(command).find(
        (candidate) => candidate.name() === value || candidate.aliases().includes(value),
      );
      return { value, description: child?.description() ?? '' };
    });
}

/** Complete a command tree without parsing or executing it. */
export function complete(program: Command, words: string[]): Completion[] {
  rejectUnsafeWords(words);
  const currentToken = words.at(-1) ?? '';
  const prior = words.slice(0, -1);
  let command = program;
  let pending: Option | undefined;
  let terminated = false;
  let operandIndex = 0;

  for (let index = 0; index < prior.length; index += 1) {
    const token = prior[index];
    if (token === undefined) break;
    if (pending) {
      if (pending.optional && token.startsWith('-') && token !== '-') {
        pending = undefined;
        index -= 1;
        continue;
      }
      pending = undefined;
      continue;
    }
    if (terminated) continue;
    if (token === '--') {
      terminated = true;
      continue;
    }
    const option = findOption(command, token);
    if (option) {
      if (token.includes('=')) continue;
      if (needsValue(option)) pending = option;
      continue;
    }
    const child = visibleCommands(command).find(
      (candidate) => candidate.name() === token || candidate.aliases().includes(token),
    );
    if (child) {
      command = child;
      operandIndex = 0;
    } else if (!token.startsWith('-')) operandIndex++;
  }

  if (pending) return choices(pending, currentToken);
  if (terminated || currentToken === '--') return [];

  if (currentToken.startsWith('-')) {
    const equals = currentToken.indexOf('=');
    if (equals > 0) {
      const option = findOption(command, currentToken.slice(0, equals));
      if (option?.argChoices)
        return choices(option, currentToken.slice(equals + 1), `${currentToken.slice(0, equals)}=`);
    }
    return optionCompletions(command, currentToken);
  }

  const argument =
    command.registeredArguments[operandIndex] ??
    (command.registeredArguments.at(-1)?.variadic ? command.registeredArguments.at(-1) : undefined);
  const argumentChoices = (argument?.argChoices ?? [])
    .filter((value) => value.startsWith(currentToken))
    .map((value) => ({ value, description: argument?.description ?? '' }));
  return currentToken === ''
    ? [...commandCompletions(command, ''), ...argumentChoices, ...optionCompletions(command, '')]
    : [...commandCompletions(command, currentToken), ...argumentChoices];
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function scriptCommand(program: Command) {
  return shellQuote(commandName(program));
}

function bashScript(program: Command) {
  const name = scriptCommand(program);
  return `# bash completion for ${commandName(program)}\n_${commandName(program)}_complete() {\n  local cur="\${COMP_WORDS[\${COMP_CWORD}]}"\n  local line value description\n  COMPREPLY=()\n  while IFS=$'\\t' read -r value description; do\n    case "$value" in\n      "$cur"*) COMPREPLY+=("$value") ;;\n    esac\n  done < <(${name} __complete -- "\${COMP_WORDS[@]:1:\${COMP_CWORD}}" 2>/dev/null)\n}\ncomplete -F _${commandName(program)}_complete ${name}\n`;
}

function zshScript(program: Command) {
  const name = scriptCommand(program);
  return `#compdef ${commandName(program)}\n_${commandName(program)}_complete() {\n  local line value description\n  local -a replies\n  replies=()\n  while IFS=$'\\t' read -r value description; do\n    [[ -n "$value" ]] && replies+=("$value:$description")\n  done < <(${name} __complete -- "\${words[2,CURRENT]}" 2>/dev/null)\n  _describe 'values' replies\n}\ncompdef _${commandName(program)}_complete ${name}\n`;
}

function fishScript(program: Command) {
  const name = shellQuote(commandName(program));
  return `function __${commandName(program)}_complete\n  set -l command_tokens (commandline -opc)\n  set -l tokens $command_tokens[2..-1]\n  set -l current (commandline -ct)\n  set -a tokens "$current"\n  ${name} __complete -- $tokens 2>/dev/null\nend\ncomplete -c ${name} -f -a '(__${commandName(program)}_complete)'\n`;
}

function powershellScript(program: Command) {
  const name = shellQuote(commandName(program));
  return `Register-ArgumentCompleter -Native -CommandName ${name} -ScriptBlock {\n  param($wordToComplete, $commandAst, $cursorPosition)\n  $words = @()\n  foreach ($element in $commandAst.CommandElements | Select-Object -Skip 1) {\n    if ($element.Extent.StartOffset -ge $cursorPosition) { break }\n    if ($element.PSObject.Properties['Value']) { $words += [string]$element.Value }\n    else { $words += [string]$element.Extent.Text }\n  }\n  if ($words.Count -eq 0 -or $words[-1] -ne $wordToComplete) { $words += $wordToComplete }\n  $arguments = @('__complete', '--') + $words\n  & ${name} @arguments 2>$null | ForEach-Object {\n    $parts = ([string]$_) -split "\`t", 2\n    if ($parts[0] -like "$wordToComplete*") {\n      [System.Management.Automation.CompletionResult]::new($parts[0], $parts[0], 'ParameterValue', $parts[1])\n    }\n  }\n}\n`;
}

export function completionScript(program: Command, shell: CompletionShell): string {
  if (!shells.has(shell)) throw new Error(`Unsupported completion shell: ${shell}`);
  if (shell === 'bash') return bashScript(program);
  if (shell === 'zsh') return zshScript(program);
  if (shell === 'fish') return fishScript(program);
  return powershellScript(program);
}
