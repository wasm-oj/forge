import cssWorkerUrl from "monaco-editor/languages/features/css/css.worker?worker&url";
import editorWorkerUrl from "monaco-editor/editor/editor.worker?worker&url";
import htmlWorkerUrl from "monaco-editor/languages/features/html/html.worker?worker&url";
import jsonWorkerUrl from "monaco-editor/languages/features/json/json.worker?worker&url";
import typescriptWorkerUrl from "monaco-editor/languages/features/typescript/ts.worker?worker&url";

type MonacoWorkerEnvironment = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker(moduleId: string, label: string): Worker;
  };
};

const workerEnvironment = globalThis as MonacoWorkerEnvironment;
workerEnvironment.MonacoEnvironment = Object.freeze({
  getWorker(_moduleId: string, label: string): Worker {
    const url = label === "json"
      ? jsonWorkerUrl
      : label === "css" || label === "scss" || label === "less"
        ? cssWorkerUrl
        : label === "html" || label === "handlebars" || label === "razor"
          ? htmlWorkerUrl
          : label === "typescript" || label === "javascript"
            ? typescriptWorkerUrl
            : editorWorkerUrl;
    return new Worker(url, { type: "module", name: `forge-monaco-${label || "editor"}` });
  },
});
