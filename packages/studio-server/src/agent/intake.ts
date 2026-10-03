import { randomBytes } from "node:crypto";
import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseAgentIntake, type AgentIntake } from "@hyperframes/agent-protocol";

/** Where Home leaves a project's start-from-chat intake. `.hyperframes/` is outside project history. */
export const INTAKE_PATH = join(".hyperframes", "agent", "intake.json");

export type IntakeClaim =
  | { status: "none" }
  | { status: "claimed"; intake: AgentIntake }
  | { status: "invalid"; message: string };

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Takes the project's intake exactly once: the file is renamed to a private name first (only one concurrent claim can
 * win the rename), then read and deleted. A second claim — another Studio tab, a reload — finds nothing.
 */
export async function claimIntake(projectDir: string): Promise<IntakeClaim> {
  const file = join(projectDir, INTAKE_PATH);
  const claimed = `${file}.claimed-${randomBytes(6).toString("hex")}`;
  try {
    await rename(file, claimed);
  } catch (error) {
    if (isMissing(error)) return { status: "none" };
    throw error;
  }
  try {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(claimed, "utf-8"));
    } catch (error) {
      // Windows renames eagerly: two claims racing the same file can both win
      // their own rename (MoveFile moves, it never fails EEXIST), and the
      // loser's private name is then consumed by the winner's rename, so the
      // loser's read lands on ENOENT. That is a lost race, not a corrupt
      // file — report "none" so the caller retries/waits like a second tab.
      if (isMissing(error)) return { status: "none" };
      return { status: "invalid", message: "The project's intake file is not valid JSON." };
    }
    const parsed = parseAgentIntake(raw);
    return parsed.ok
      ? { status: "claimed", intake: parsed.value }
      : { status: "invalid", message: `The project's intake file is invalid: ${parsed.message}` };
  } finally {
    await rm(claimed, { force: true });
  }
}
