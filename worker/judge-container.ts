import { Container } from "@cloudflare/containers";
import type { WasmOjWorkerEnv } from "./env";
import { constantTimeEqual, sha256Hex } from "./crypto";
import { ApiError, apiErrorResponse, jsonResponse, readBoundedResponseBytes, readJsonBody } from "./http";
import { parseExecuteRequest, type SubmissionExecuteRequest } from "./container-job";
import { publicSubmissionEvent } from "../src/online-judge/contracts";
import {
  assertContainerIdentityFence,
  establishContainerIdentityFence,
  parseProbedContainerIdentity,
  readBoundedProbedContainerIdentity,
  type ContainerIdentityFence,
  type ContainerIdentityWorkerBinding,
} from "./container-identity-fence";
import { appendAuthorizedSubmissionEvent, containerSubmissionEventKey } from "./submission-events";

type JobAuthorization = Omit<SubmissionExecuteRequest, "attemptToken"> & { readonly attemptTokenHash: string };
const STORAGE_DELETE_BATCH_SIZE = 128;

export async function cleanupOneShotContainer(
  storage: Pick<DurableObjectStorage, "list" | "delete">,
  destroy: () => Promise<void>,
): Promise<void> {
  let cleanupFailed = false;
  try {
    while (true) {
      const values = await storage.list({ prefix: "output:", limit: STORAGE_DELETE_BATCH_SIZE });
      const keys = [...values.keys()];
      if (keys.length === 0) break;
      if (await storage.delete(keys) !== keys.length) throw new Error("Durable Object cleanup made no complete progress.");
    }
  } catch { cleanupFailed = true; }
  try { await storage.delete(["authorization", "identity-fence"]); } catch { cleanupFailed = true; }
  try { await destroy(); } catch { cleanupFailed = true; }
  if (cleanupFailed) throw new ApiError(500, "container-cleanup", "One-shot Container cleanup did not complete.");
}

export class SubmissionJudgeContainer extends Container<WasmOjWorkerEnv> {
  defaultPort = 8080;
  sleepAfter = "30s";
  enableInternet = false;
  allowedHosts = ["wasm-oj-job.internal"];
  interceptHttps = false;

  private currentWorkerBinding(): ContainerIdentityWorkerBinding {
    const binding = {
      environment: this.env.ENVIRONMENT,
      buildId: this.env.WASM_OJ_BUILD_ID,
      workerVersionId: this.env.CF_VERSION_METADATA.id,
    };
    if (this.env.CF_VERSION_METADATA.tag !== binding.buildId) {
      throw new ApiError(409, "worker-build-mismatch", "Worker version tag does not match its build ID.");
    }
    return binding;
  }

  private async probeContainerIdentity(): Promise<unknown> {
    const response = await super.fetch(new Request("http://container/identity", { method: "GET" }) as never);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ApiError(409, "container-identity-mismatch", "Judge Container identity could not be verified.");
    }
    try { return await readBoundedProbedContainerIdentity(response); } catch {
      throw new ApiError(409, "container-identity-mismatch", "Judge Container identity could not be verified.");
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__wasm-oj/")) return this.handleOutbound(request);
    if (request.method === "GET" && url.pathname === "/identity") {
      try { return jsonResponse(parseProbedContainerIdentity(await this.probeContainerIdentity())); }
      catch (error) { return apiErrorResponse(error); }
      finally { await this.destroy(); }
    }
    if (request.method !== "POST" || url.pathname !== "/execute") {
      return jsonResponse({ error: { code: "container-route-not-found", message: "Container accepts one execute request." } }, 404);
    }
    try {
      let job: SubmissionExecuteRequest;
      try {
        job = parseExecuteRequest(await readJsonBody(request.clone() as unknown as Parameters<typeof readJsonBody>[0], 64 * 1024));
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(400, "job-invalid", "Container job does not match the exact protocol.");
      }
      const existing = await this.ctx.storage.get(["authorization", "identity-fence"]);
      if (existing.size > 0) throw new ApiError(409, "container-one-shot", "A judge container cannot be reused.");
      const authorizedJob = Object.fromEntries(Object.entries(job).filter(([key]) => key !== "attemptToken")) as Omit<JobAuthorization, "attemptTokenHash">;
      const authorization = { ...authorizedJob, attemptTokenHash: await sha256Hex(job.attemptToken) } as JobAuthorization;
      const containerRequest = new Request(request, { headers: new Headers({ "content-type": "application/json" }) });
      try {
        const forwarded = await establishContainerIdentityFence({
          probe: () => this.probeContainerIdentity(),
          job: {
            jobId: job.jobId,
            attempt: job.attempt,
            attemptTokenHash: authorization.attemptTokenHash,
            expectedBuildId: job.expectedBuildId,
            expectedWorkerVersionId: job.expectedWorkerVersionId,
          },
          worker: this.currentWorkerBinding(),
          commit: async (fence) => this.ctx.storage.put({ authorization, "identity-fence": fence }),
          forward: () => super.fetch(containerRequest as never),
        });
        // The container is deliberately one-shot. Materialize only its small,
        // bounded aggregate result before destruction so no response stream can
        // outlive the process that produced it.
        const resultBytes = await readBoundedResponseBytes(forwarded, 64 * 1024);
        const resultBody = new ArrayBuffer(resultBytes.byteLength);
        new Uint8Array(resultBody).set(resultBytes);
        resultBytes.fill(0);
        return new Response(resultBody, {
          status: forwarded.status,
          statusText: forwarded.statusText,
          headers: forwarded.headers,
        });
      } catch (error) {
        if (error instanceof TypeError) throw new ApiError(409, "container-identity-mismatch", "Judge Container identity could not be verified.");
        throw error;
      }
    } catch (error) {
      return apiErrorResponse(error);
    } finally {
      await cleanupOneShotContainer(this.ctx.storage, () => this.destroy());
    }
  }

  private async authorization(request: Request): Promise<JobAuthorization> {
    const [authorization, fence] = await Promise.all([
      this.ctx.storage.get<JobAuthorization>("authorization"),
      this.ctx.storage.get<ContainerIdentityFence>("identity-fence"),
    ]);
    const token = request.headers.get("x-wasm-oj-attempt-token");
    const tokenHash = token ? await sha256Hex(token) : undefined;
    if (!authorization || !fence || !token || !tokenHash || !constantTimeEqual(authorization.attemptTokenHash, tokenHash)) {
      throw new ApiError(401, "container-authorization", "Container object authorization failed.");
    }
    try { assertContainerIdentityFence(fence, authorization, tokenHash, this.currentWorkerBinding()); }
    catch { throw new ApiError(401, "container-authorization", "Container object authorization failed."); }
    return authorization;
  }

  private async handleOutbound(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const authorization = await this.authorization(request);
      if (request.method === "GET" && url.pathname === "/__wasm-oj/r2/source") {
        return this.r2Object(authorization.sourceR2Key, authorization.sourceSha256);
      }
      if (request.method === "GET" && url.pathname === "/__wasm-oj/r2/judge") {
        return this.r2Object(authorization.judgeR2Key, authorization.judgeDigest);
      }
      if (request.method === "POST" && url.pathname === "/__wasm-oj/events") {
        const event = publicSubmissionEvent(await readJsonBody(request, 32 * 1024));
        const appended = await appendAuthorizedSubmissionEvent(this.env, {
          submissionId: authorization.submissionId,
          attempt: authorization.attempt,
          attemptTokenHash: authorization.attemptTokenHash,
          eventKey: await containerSubmissionEventKey(authorization.attempt, event),
          event,
        });
        return jsonResponse(appended, appended.duplicate ? 200 : 201);
      }
      return jsonResponse({ error: { code: "container-egress-denied", message: "Object is not authorized for this one-shot job." } }, 403);
    } catch (error) { return apiErrorResponse(error); }
  }

  private async r2Object(key: string, expectedSha256: string): Promise<Response> {
    const object = await this.env.JUDGE_BUCKET.get(key);
    if (!object) throw new ApiError(404, "r2-object-missing", "Authorized job object does not exist.");
    if (object.checksums.toJSON().sha256 !== expectedSha256) {
      throw new ApiError(500, "r2-object-integrity", "Authorized job object checksum does not match its expected digest.");
    }
    const headers = new Headers({ "content-type": object.httpMetadata?.contentType ?? "application/octet-stream" });
    headers.set("content-length", String(object.size));
    if (object.checksums.sha256) headers.set("digest", `sha-256=${btoa(String.fromCharCode(...new Uint8Array(object.checksums.sha256)))}`);
    headers.set("x-wasm-oj-sha256", expectedSha256);
    return new Response(object.body, { headers });
  }
}

SubmissionJudgeContainer.outboundByHost = {
  "wasm-oj-job.internal": async (request: Request, env: unknown, context: { readonly containerId: string }) => {
    const namespace = (env as WasmOjWorkerEnv).SUBMISSION_CONTAINER;
    const stub = namespace.get(namespace.idFromString(context.containerId));
    const target = new URL(request.url);
    target.protocol = "https:";
    target.hostname = "container.internal";
    target.pathname = `/__wasm-oj${target.pathname}`;
    return stub.fetch(new Request(target, request));
  },
};
