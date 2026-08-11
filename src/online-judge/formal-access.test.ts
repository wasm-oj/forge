import { describe, expect, it } from "vitest";
import { parseGithubUserAllowlist } from "../../worker/formal-access";

describe("staging GitHub user allowlist", () => {
  it("accepts exact numeric identities and removes duplicates", () => {
    expect([...parseGithubUserAllowlist("123, 456,123")]).toEqual([123, 456]);
  });

  it.each(["0", "-1", "1.5", "alice", "1,,2", "9007199254740992"])("rejects malformed value %s", (value) => {
    expect(() => parseGithubUserAllowlist(value)).toThrow();
  });
});
