import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { WasmOjWorkerEnv } from "./env";
import { PromptAttemptService } from "./prompt-attempts";
import { hostPromptCompilerRegistry } from "./prompt-compiler-registry";
import { createPromptAttemptHost } from "./submissions";
import {
  parsePromptAttemptWorkflowParameters,
  type PromptAttemptWorkflowParameters,
} from "./prompt-workflow-identity";

export class PromptAttemptWorkflow extends WorkflowEntrypoint<WasmOjWorkerEnv, PromptAttemptWorkflowParameters> {
  async run(
    event: WorkflowEvent<PromptAttemptWorkflowParameters>,
    step: WorkflowStep,
  ): Promise<{ readonly attemptId: string }> {
    const input = parsePromptAttemptWorkflowParameters(event.payload);
    const service = new PromptAttemptService({
      database: this.env.DB,
      registry: hostPromptCompilerRegistry(),
      host: createPromptAttemptHost(this.env),
    });
    await service.markWorkflowDispatched(input.attemptId);
    try {
      await step.do("compile prompt and admit locked source", {
        retries: { limit: 0, delay: "1 second" },
        timeout: "70 minutes",
      }, async () => {
        await service.runReserved(input.attemptId);
        return { attemptId: input.attemptId };
      });
    } catch {
      await service.failWorkflowExecution(input.attemptId);
    }
    return { attemptId: input.attemptId };
  }
}
