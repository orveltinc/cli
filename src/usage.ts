import type { Command } from 'commander';

/** Derive machine-readable help from the parser, never from a second command catalog. */
function commandUsage(command: Command): object {
  const helper = command.createHelp();
  const path: string[] = [];
  for (let current: Command | null = command; current; current = current.parent) {
    path.unshift(current.name());
  }
  const options = [...helper.visibleOptions(command), ...helper.visibleGlobalOptions(command)];
  return {
    command: path.join(' '),
    description: command.description(),
    aliases: command.aliases(),
    arguments: command.registeredArguments.map((argument) => ({
      name: argument.name(),
      description: argument.description,
      required: argument.required,
      variadic: argument.variadic,
    })),
    options: [...new Map(options.map((option) => [option.flags, option])).values()].map(
      (option) => ({
        flags: option.flags,
        description: option.description,
        requiresValue: option.required,
        optionalValue: option.optional,
        repeatable: option.variadic,
        default: option.defaultValue as unknown,
        environment: option.envVar,
        choices: option.argChoices,
      }),
    ),
    commands: helper.visibleCommands(command).map(commandUsage),
  };
}

export function installUsage(command: Command, write: (text: string) => void) {
  command.option('--usage', 'print this command subtree as JSON without connecting');
  let requested = false;
  command.on('option:usage', () => {
    if (requested) return;
    requested = true;
    // Let Commander resolve the requested subtree and validate unknown arguments.
    // Snapshot first: documentation still marks the real required arguments.
    const snapshots = new Map<Command, object>();
    const collect = (current: Command) => {
      snapshots.set(current, commandUsage(current));
      for (const child of current.commands) collect(child);
    };
    collect(command);
    for (const [current, snapshot] of snapshots) {
      for (const argument of current.registeredArguments) argument.argOptional();
      for (const option of current.options) option.makeOptionMandatory(false);
      current.action(() => {
        write(
          `${JSON.stringify({ schemaVersion: 1, ...snapshot, exitCodes: { success: 0, failure: 1, usage: 2, cancelled: 130 } }, null, 2)}\n`,
        );
      });
    }
  });
}
