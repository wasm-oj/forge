import type { Language, Project, ProjectFile } from "./types";

const TEMPLATE_FILES: Record<Language, ProjectFile[]> = {
  c: [
    { path: "src/main.c", language: "c", content: `#include <stdio.h>\n#include "greeting.h"\n\nint main(void) {\n    printf("%s\\n", greeting());\n    return 0;\n}\n` },
    { path: "src/greeting.c", language: "c", content: `#include "greeting.h"\n\nconst char *greeting(void) {\n    return "Hello from C on WASI";\n}\n` },
    { path: "src/greeting.h", language: "c", content: `#pragma once\n\nconst char *greeting(void);\n` },
  ],
  cpp: [
    { path: "src/main.cpp", language: "cpp", content: `extern "C" int puts(const char *);\n\nclass Greeting {\npublic:\n    const char *message() const { return "Hello from C++ on WASI"; }\n};\n\nint main() {\n    Greeting greeting;\n    puts(greeting.message());\n    return 0;\n}\n` },
  ],
  rust: [
    { path: "src/main.rs", language: "rust", content: `fn square(value: i32) -> i32 {\n    return value * value;\n}\n\nfn main() {\n    let answer: i32 = square(7);\n    println!("Hello from Rust/WASI core: {}", answer);\n}\n` },
  ],
  python: [
    { path: "src/main.py", language: "python", content: `from greeting import message\n\nprint(message("Python"))\n` },
    { path: "src/greeting.py", language: "python", content: `def message(language: str) -> str:\n    return f"Hello from {language} on WASIX"\n` },
  ],
  javascript: [
    { path: "src/main.js", language: "javascript", content: `import { message } from "./greeting.js";\n\nconsole.log(message("JavaScript"));\n` },
    { path: "src/greeting.js", language: "javascript", content: `export function message(language) {\n  return \`Hello from \${language} on WASI\`;\n}\n` },
  ],
  typescript: [
    { path: "src/main.ts", language: "typescript", content: `import { message } from "./greeting.js";\n\nconst language: string = "TypeScript";\nconsole.log(message(language));\n` },
    { path: "src/greeting.ts", language: "typescript", content: `export function message(language: string): string {\n  return \`Hello from \${language} on WASI\`;\n}\n` },
  ],
};

const ENTRIES: Record<Language, string> = {
  c: "src/main.c",
  cpp: "src/main.cpp",
  rust: "src/main.rs",
  python: "src/main.py",
  javascript: "src/main.js",
  typescript: "src/main.ts",
};

export function createProject(language: Language, name = "hello-wasi"): Project {
  const files = TEMPLATE_FILES[language].map((file) => ({ ...file }));
  return {
    id: crypto.randomUUID(),
    name,
    files,
    activeFile: ENTRIES[language],
    updatedAt: Date.now(),
    config: {
      language,
      target: language === "python" ? "wasix" : "wasi",
      optimization: "debug",
      entry: ENTRIES[language],
      args: [],
      stdin: "",
      env: {},
    },
  };
}

export function defaultEntry(language: Language): string {
  return ENTRIES[language];
}
