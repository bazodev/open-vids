/**
 * Runs `edit_timeline` operations through OMP's real argument validator and then OpenVids' own reading, the way a tool
 * call travels. Only Bun can load OMP; `blank-arguments.test.ts` starts this file with `bun` and checks each outcome.
 *
 * Usage: bun blank-arguments.probe.ts <json array of operations>
 */
import { validateToolArguments } from "@oh-my-pi/pi-ai";
import { parseApplyEditsRequest } from "@hyperframes/agent-protocol";
import { withoutBlankArguments } from "./args.ts";
import { buildEditingTools } from "./tools.ts";

const operations: unknown = JSON.parse(process.argv[2] ?? "[]");
if (!Array.isArray(operations)) throw new Error("operations must be an array");

const tool = buildEditingTools("editor", ["editor"], async () => ({ text: "" }), {
  voice: true,
}).find((candidate) => candidate.name === "edit_timeline");
if (!tool) throw new Error("edit_timeline is not offered");

const outcomes = operations.map((operation) => {
  try {
    const reached = validateToolArguments(tool, {
      type: "toolCall",
      id: "probe",
      name: tool.name,
      arguments: { operations: [operation] },
    });
    const parsed = parseApplyEditsRequest(withoutBlankArguments(reached));
    return parsed.ok
      ? { read: parsed.value.operations[0] }
      : { refusedBy: "parser", message: parsed.error.message };
  } catch (error) {
    return { refusedBy: "sdk", message: error instanceof Error ? error.message : String(error) };
  }
});
process.stdout.write(JSON.stringify(outcomes));
