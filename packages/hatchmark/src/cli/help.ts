export interface OptionHelp {
  flag: string;
  description: string;
}

export interface CommandHelp {
  name: string;
  summary: string;
  usage: string;
  options: OptionHelp[];
  example: { command: string; description: string };
}

export const GLOBAL_OPTIONS: OptionHelp[] = [
  {
    flag: "--json",
    description:
      "Print one line of JSON on stdout (the default when stdout is not a terminal or an agent runs the command).",
  },
  { flag: "--format <human|json>", description: "Choose the output format explicitly." },
  { flag: "--cwd <dir>", description: "Run as if started in <dir>." },
  { flag: "--quiet", description: "Print nothing on success in human mode." },
  { flag: "--no-color", description: "Disable colour (also honours NO_COLOR)." },
  { flag: "--yes, -y", description: "Accepted for scripts; Hatchmark never asks questions." },
  { flag: "--help, -h", description: "Show help for the command." },
];

export function renderCommandHelp(help: CommandHelp): string {
  const width = Math.max(...[...help.options, ...GLOBAL_OPTIONS].map((o) => o.flag.length));
  const line = (o: OptionHelp) => `  ${o.flag.padEnd(width)}  ${o.description}`;
  return [
    `${help.summary}`,
    "",
    `Usage: ${help.usage}`,
    ...(help.options.length > 0 ? ["", "Options:", ...help.options.map(line)] : []),
    "",
    "Global options:",
    ...GLOBAL_OPTIONS.map(line),
    "",
    "Example:",
    `  ${help.example.command}`,
    `  ${help.example.description}`,
  ].join("\n");
}

export function renderTopHelp(commands: readonly CommandHelp[], version: string): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  return [
    `hatchmark ${version}: agent-first dashboards from YAML specs`,
    "",
    "Usage: hatchmark <command> [options]",
    "",
    "Commands:",
    ...commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    "",
    "Run hatchmark <command> --help for its options and an example.",
    "",
    "Output: human text in a terminal; one line of JSON on stdout when stdout is not a terminal,",
    "an AI agent runs the command, or --json is passed. Logs go to stderr. Nothing ever prompts.",
    "",
    "Exit codes: 0 ok (warnings allowed), 1 errors in your files, 2 usage or config error,",
    "3 environment problem (such as a missing data file), 4 internal bug.",
  ].join("\n");
}
