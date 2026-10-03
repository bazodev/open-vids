import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => {
  const mocked = { spawn: spawnMock };
  return { ...mocked, default: mocked };
});

import { openerCommand, openInDefaultApp } from "./openInDefaultApp.js";

describe("openerCommand", () => {
  it("passes the file through untouched on every platform", () => {
    // `cmd /c start` re-parses its tail: a bare `a&b` truncates at the `&`
    // and no extra quoting survives both spaces and `&` (probed against
    // cmd.exe), so Windows goes straight to explorer.exe with one argv
    // element instead. Either way the path itself is never rewritten.
    const path = "C:\\renders\\Talk, part 2 & intro.mp4";
    const [command, args] = openerCommand(path);
    expect(args).toEqual([path]);
    if (process.platform === "win32") {
      expect(command).toBe("explorer.exe");
    } else if (process.platform === "darwin") {
      expect(command).toBe("/usr/bin/open");
    } else {
      expect(command).toBe("xdg-open");
    }
  });

  it("spawns the launcher with the console hidden", async () => {
    const proc = Object.assign(new EventEmitter(), { killed: false });
    spawnMock.mockReturnValueOnce(proc);
    const done = openInDefaultApp("C:\\renders\\out.mp4");
    proc.emit("close", 0);
    await done;
    expect(spawnMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ windowsHide: true }));
  });
});
