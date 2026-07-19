import { describe, expect, it } from "vitest";
import {
  BROWSER_PROBLEM_CATALOG_SCHEMA,
  parseBrowserProblemCatalog,
} from "./problem-catalog-loader";
import { PROBLEMS } from "./problems";

describe("browser problem catalog", () => {
  it("accepts the generated ordered catalog", () => {
    expect(parseBrowserProblemCatalog({
      schema: BROWSER_PROBLEM_CATALOG_SCHEMA,
      problems: PROBLEMS,
    })).toEqual(PROBLEMS);
  });

  it("rejects incomplete and misordered catalogs", () => {
    expect(() => parseBrowserProblemCatalog({
      schema: BROWSER_PROBLEM_CATALOG_SCHEMA,
      problems: PROBLEMS.slice(1),
    })).toThrow("must contain 45 problems");
    expect(() => parseBrowserProblemCatalog({
      schema: BROWSER_PROBLEM_CATALOG_SCHEMA,
      problems: [PROBLEMS[1], PROBLEMS[0], ...PROBLEMS.slice(2)],
    })).toThrow("invalid problem at position 1");
  });
});
