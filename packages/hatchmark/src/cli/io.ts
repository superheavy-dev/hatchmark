export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdoutIsTTY: boolean;
  isAgent(): Promise<boolean>;
}

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
  root: string;
  mode: OutputMode;
  color: boolean;
  quiet: boolean;
}

export interface CommandResult {
  exitCode: ExitCode;
  json: unknown;
  human: string;
}

export interface PrintedResult {
  exitCode: ExitCode;
  printed: true;
}
