import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;

export interface HerdrResult<T = unknown> {
  ok?: boolean;
  result?: T;
  error?: { code?: string; message?: string } | unknown;
}

export class HerdrCommandError extends Error {
  constructor(
    message: string,
    readonly codeName?: string,
    readonly stderrText?: string,
  ) {
    super(message);
    this.name = "HerdrCommandError";
  }
}

export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_PANE_ID);
}

export function getHerdrSocketPath(): string | undefined {
  return process.env.HERDR_SOCKET_PATH || undefined;
}

async function exec(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const binary = process.env.HERDR_BIN_PATH || "herdr";
  try {
    const result = await execFileAsync(binary, args, {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      env: process.env,
    });
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string; code?: string | number };
    const stderr = String(e.stderr ?? "").trim();
    let codeName: string | undefined;
    let message = stderr || e.message;
    if (stderr) {
      try {
        const parsed = JSON.parse(stderr) as HerdrResult;
        const raw = parsed.error;
        if (raw && typeof raw === "object") {
          const obj = raw as { code?: unknown; message?: unknown };
          if (typeof obj.code === "string") codeName = obj.code;
          if (typeof obj.message === "string") message = obj.message;
        }
      } catch {
        // Keep raw stderr when Herdr did not emit JSON.
      }
    }
    throw new HerdrCommandError(message, codeName, stderr);
  }
}

export async function herdrJson<T = unknown>(args: string[]): Promise<HerdrResult<T>> {
  const { stdout } = await exec(args);
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as HerdrResult<T>;
    if (parsed.error && typeof parsed.error === "object") {
      const err = parsed.error as { code?: unknown; message?: unknown };
      throw new HerdrCommandError(
        typeof err.message === "string" ? err.message : `Herdr command failed: ${args.join(" ")}`,
        typeof err.code === "string" ? err.code : undefined,
        trimmed,
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof HerdrCommandError) throw error;
    throw new Error(`Herdr returned non-JSON output for: herdr ${args.join(" ")}\n${trimmed}`);
  }
}

export async function herdrText(args: string[]): Promise<string> {
  const { stdout } = await exec(args);
  return stdout.trimEnd();
}

export function assertHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error("pi-herdr-fleet requires Pi to run inside Herdr (HERDR_ENV=1 and HERDR_PANE_ID set).");
  }
}
