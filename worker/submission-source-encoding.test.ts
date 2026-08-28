import { describe, expect, it } from "vitest";
import { encodeOfficialSourceDocument } from "./submissions";

describe("official source document encoding", () => {
  it("preserves Prompt Program UTF-8 file encoding for the judge container", async () => {
    const request = {
      language: "c",
      target: "wasip1",
      optimization: "release",
      entry: "main.c",
      sourceFiles: [{
        path: "main.c",
        encoding: "utf8" as const,
        content: "int main(void) { return 0; }\n",
      }],
    };
    const bytes = await encodeOfficialSourceDocument(request);
    const document = JSON.parse(new TextDecoder().decode(bytes)) as {
      readonly schema: string;
      readonly sourceDigest: string;
      readonly request: typeof request;
    };

    expect(document.schema).toBe("wasm-oj-platform/official-source/v1");
    expect(document.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(document.request).toEqual(request);
    expect(document.request.sourceFiles[0]?.encoding).toBe("utf8");
  });
});
