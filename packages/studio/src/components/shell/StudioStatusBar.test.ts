import { describe, expect, it } from "vitest";
import { homeRelative } from "./StudioStatusBar";

describe("homeRelative", () => {
  it("shortens macOS home paths", () => {
    expect(homeRelative("/Users/alice/Movies/OpenVids")).toBe("~/Movies/OpenVids");
    expect(homeRelative("/Users/alice")).toBe("~");
  });

  it("shortens Linux home paths", () => {
    expect(homeRelative("/home/alice/Movies/OpenVids")).toBe("~/Movies/OpenVids");
    expect(homeRelative("/home/alice")).toBe("~");
  });

  it("leaves non-home POSIX paths alone", () => {
    expect(homeRelative("/Volumes/Data/Projects")).toBe("/Volumes/Data/Projects");
    expect(homeRelative("/Users")).toBe("/Users");
    expect(homeRelative("/home")).toBe("/home");
    expect(homeRelative("/Usersx/alice/x")).toBe("/Usersx/alice/x");
  });

  it("shortens Windows home paths with backslashes", () => {
    expect(homeRelative("C:\\Users\\alice\\Movies\\OpenVids")).toBe("~\\Movies\\OpenVids");
    expect(homeRelative("C:\\Users\\alice")).toBe("~");
  });

  it("shortens Windows home paths with forward slashes and any drive-letter case", () => {
    expect(homeRelative("C:/Users/alice/Movies/OpenVids")).toBe("~/Movies/OpenVids");
    expect(homeRelative("c:\\Users\\alice\\Movies")).toBe("~\\Movies");
    expect(homeRelative("D:\\Users\\Alice Smith\\Videos\\x")).toBe("~\\Videos\\x");
  });

  it("leaves non-home Windows paths alone", () => {
    expect(homeRelative("D:\\Media\\Projects")).toBe("D:\\Media\\Projects");
    expect(homeRelative("C:\\Users")).toBe("C:\\Users");
    expect(homeRelative("C:\\Users\\")).toBe("C:\\Users\\");
  });
});
