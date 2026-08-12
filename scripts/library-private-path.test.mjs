import assert from "node:assert/strict";
import test from "node:test";
import { containsPrivateSourcePath } from "./library-private-path.mjs";

test("does not treat /project/src as private when the repository root is exactly /src", () => {
  assert.equal(containsPrivateSourcePath("//# sourceMappingURL=/project/src/index.js.map", "/src"), false);
  assert.equal(containsPrivateSourcePath('import "/project/src/index.js";', "/src"), false);
});

test("still detects the exact repository root across path and file URL forms", () => {
  assert.equal(containsPrivateSourcePath('import "/src/index.js";', "/src"), true);
  assert.equal(containsPrivateSourcePath("file:///src/index.ts", "/src"), true);
  assert.equal(containsPrivateSourcePath("prefix=/src", "/src"), true);
  assert.equal(containsPrivateSourcePath("/src-other/index.ts", "/src"), false);
});
