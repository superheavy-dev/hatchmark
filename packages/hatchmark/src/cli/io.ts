/** Everything a command touches outside its arguments, so tests can run the CLI in-process. */
export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdoutIsTTY: boolean;
  /** Whether an AI coding agent runs this process (Claude Code, Codex, Cursor, ...). */
  isAgent(): Promise<boolean>;
}

/** Exit codes, documented in docs/cli.md. */
export const EXIT = {
  ok: 0,
  check: 1,
  usage: 2,
  environment: 3,
  internal: 4,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type OutputMode = "json" | "human";

export interface CommandContext {
  io: CliIO;
  /** Absolute project directory: --cwd resolved against the process directory. */
  root: string;
  mode: OutputMode;
  color: boolean;
  quiet: boolean;
}

export interface CommandResult {
  exitCode: ExitCode;
  /** Printed as one line of JSON in json mode. */
  json: unknown;
  /** Printed in human mode. */
  human: string;
}
