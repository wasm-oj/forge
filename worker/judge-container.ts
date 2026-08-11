import { Container } from "@cloudflare/containers";
import type { ForgeWorkerEnv } from "./env";
import { constantTimeEqual, sha256Hex } from "./crypto";
import { ApiError, apiErrorResponse, jsonResponse, readBoundedRequestBytes, readJsonBody } from "./http";
import {
  parseExecuteRequest,
  type SubmissionExecuteRequest,
  type ValidationExecuteRequest,
} from "./container-job";
import { publicSubmissionEvent } from "../src/online-judge/contracts";
import { claimImportObject, releaseImportObjectClaim, type ClaimedObject } from "./canonical-object-claims";
import { putImmutableObject } from "./immutable-r2";
import { assertActiveRelease } from "./release";
import {
  assertContainerIdentityFence,
  establishContainerIdentityFence,
  parseProbedContainerIdentity,
  readBoundedProbedContainerIdentity,
  type ContainerIdentityFence,
  type ContainerIdentityReleaseBinding,
  type ContainerIdentityWorkerBinding,
} from "./container-identity-fence";
import {
  appendAuthorizedSubmissionEvent,
  containerSubmissionEventKey,
} from "./submission-events";

type JobAuthorization = (
  | Omit<SubmissionExecuteRequest, "attemptToken">
  | Omit<ValidationExecuteRequest, "attemptToken">
) & {
  readonly attemptTokenHash: string;
};

interface AuthorizedOutput {
  readonly jobId: string;
  readonly key: string;
  readonly digest: string;
  readonly bytes: number;
}

const MAX_VALIDATION_OUTPUT_BYTES = 32 * 1024 * 1024;

abstract class SecureJudgeContainer extends Container<ForgeWorkerEnv> {
  protected abstract readonly acceptedKind: "submission" | "validation";
  defaultPort = 8080;
  sleepAfter = "30s";
  enableInternet = false;
  allowedHosts = ["forge-job.internal"];
  interceptHttps = false;

  private currentWorkerBinding(): ContainerIdentityWorkerBinding {
    return {
      environment: this.env.ENVIRONMENT,
      releaseId: this.env.FORGE_RELEASE_ID,
      manifestSha256: this.env.FORGE_RELEASE_MANIFEST_SHA256,
      workerVersionId: this.env.CF_VERSION_METADATA.id,
    };
  }

  private async probeContainerIdentity(): Promise<unknown> {
    const response = await super.fetch(new Request("http://container/identity", { method: "GET" }) as never);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ApiError(409, "container-identity-mismatch", "Judge Container identity could not be verified.");
    }
    try {
      return await readBoundedProbedContainerIdentity(response);
    } catch {
      throw new ApiError(409, "container-identity-mismatch", "Judge Container identity could not be verified.");
    }
  }

  private async loadReleaseBinding(expectedReleaseId: string, expectedManifestSha256: string): Promise<ContainerIdentityReleaseBinding> {
    const active = await assertActiveRelease(
      this.env.DB,
      this.env.JUDGE_BUCKET,
      this.env.ENVIRONMENT,
      expectedReleaseId,
      expectedManifestSha256,
    );
    const worker = this.currentWorkerBinding();
    if (
      active.releaseId !== worker.releaseId
      || active.manifestSha256 !== worker.manifestSha256
    ) throw new ApiError(409, "container-identity-mismatch", "Judge Container identity could not be verified.");
    return {
      environment: worker.environment,
      releaseId: active.releaseId,
      manifestSha256: active.manifestSha256,
      workerVersionId: worker.workerVersionId,
      forgeContract: active.manifest.forgeContract,
      sourceCommit: active.manifest.source.commit,
      containerIdentitySha256: active.manifest.artifacts.containerImage.identitySha256,
      protocol: active.manifest.runtime.protocolVersion,
      executionRootSha256: active.manifest.runtime.executionRootSha256,
      runtimeRootSha256: active.manifest.runtime.rootSha256,
      toolchainRootSha256: active.manifest.toolchains.rootSha256,
      compilerSha256: active.manifest.runtime.compilerSha256,
      runnerSha256: active.manifest.runtime.runnerSha256,
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__forge/")) return this.handleOutbound(request);
    if (request.method === "GET" && url.pathname === "/identity") {
      try {
        return jsonResponse(parseProbedContainerIdentity(await this.probeContainerIdentity()));
      } catch (error) {
        return apiErrorResponse(error);
      } finally { await this.destroy(); }
    }
    if (request.method !== "POST" || url.pathname !== "/execute") {
      return jsonResponse({ error: { code: "container-route-not-found", message: "Container accepts one execute request." } }, 404);
    }
    try {
      let job;
      try {
        job = parseExecuteRequest(await readJsonBody(
          request.clone() as unknown as Parameters<typeof readJsonBody>[0],
          64 * 1024,
        ));
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(400, "job-invalid", "Container job does not match the exact protocol.");
      }
      if (job.kind !== this.acceptedKind) throw new ApiError(409, "container-pool-mismatch", "Job kind is not admitted by this container pool.");
      const existing = await this.ctx.storage.get(["authorization", "identity-fence"]);
      if (existing.size > 0) throw new ApiError(409, "container-one-shot", "A judge container cannot be reused.");
      const authorizedJob = Object.fromEntries(Object.entries(job).filter(([key]) => key !== "attemptToken")) as Omit<JobAuthorization, "attemptTokenHash">;
      const authorization = {
        ...authorizedJob,
        attemptTokenHash: await sha256Hex(job.attemptToken),
      } as JobAuthorization;
      const containerRequest = new Request(request, {
        headers: new Headers({ "content-type": "application/json" }),
      });
      try {
        return await establishContainerIdentityFence({
          probe: () => this.probeContainerIdentity(),
          job: {
            jobId: job.jobId,
            attempt: job.attempt,
            attemptTokenHash: authorization.attemptTokenHash,
            expectedReleaseId: job.expectedReleaseId,
            expectedManifestSha256: job.expectedManifestSha256,
            expectedContainerIdentitySha256: job.expectedContainerIdentitySha256,
          },
          loadRelease: () => this.loadReleaseBinding(job.expectedReleaseId, job.expectedManifestSha256),
          commit: async (fence) => {
            await this.ctx.storage.put({
              authorization,
              "identity-fence": fence,
            });
          },
          forward: () => super.fetch(containerRequest as never),
        });
      } catch (error) {
        if (error instanceof TypeError) {
          throw new ApiError(409, "container-identity-mismatch", "Judge Container identity could not be verified.");
        }
        throw error;
      }
    } catch (error) {
      return apiErrorResponse(error);
    } finally {
      // Every /execute request is one-shot, including malformed jobs. Storage
      // cleanup failures must never skip the actual Container destruction.
      let cleanupFailed = false;
      try {
        const outputs = await this.ctx.storage.list({ prefix: "output:" });
        if (outputs.size > 0) await this.ctx.storage.delete([...outputs.keys()]);
      } catch { cleanupFailed = true; }
      try { await this.destroy(); } catch { cleanupFailed = true; }
      try {
        await this.ctx.storage.delete(["authorization", "identity-fence"]);
      } catch { cleanupFailed = true; }
      if (cleanupFailed) throw new ApiError(500, "container-cleanup", "One-shot Container cleanup did not complete.");
    }
  }

  private async authorization(request: Request): Promise<JobAuthorization> {
    const [authorization, fence] = await Promise.all([
      this.ctx.storage.get<JobAuthorization>("authorization"),
      this.ctx.storage.get<ContainerIdentityFence>("identity-fence"),
    ]);
    const token = request.headers.get("x-forge-attempt-token");
    const tokenHash = token ? await sha256Hex(token) : undefined;
    if (!authorization || !fence || !token || !tokenHash || !constantTimeEqual(authorization.attemptTokenHash, tokenHash)) {
      throw new ApiError(401, "container-authorization", "Container object authorization failed.");
    }
    try {
      assertContainerIdentityFence(fence, authorization, tokenHash, this.currentWorkerBinding());
    } catch {
      throw new ApiError(401, "container-authorization", "Container object authorization failed.");
    }
    return authorization;
  }

  private async handleOutbound(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const authorization = await this.authorization(request);
      if (request.method === "GET" && url.pathname === "/__forge/r2/source" && authorization.kind === "submission") {
        return this.r2Object(authorization.sourceR2Key, authorization.sourceSha256);
      }
      if (request.method === "GET" && url.pathname === "/__forge/r2/judge" && authorization.kind === "submission") {
        return this.r2Object(authorization.judgeR2Key, authorization.judgeSha256);
      }
      if (request.method === "GET" && url.pathname === "/__forge/r2/archive" && authorization.kind === "validation" && authorization.source.kind === "github-archive") {
        return this.r2Object(authorization.source.archiveR2Key);
      }
      if (request.method === "GET" && url.pathname.startsWith("/__forge/r2/output/") && authorization.kind === "validation") {
        const digest = url.pathname.slice("/__forge/r2/output/".length);
        const output = await this.ctx.storage.get<AuthorizedOutput>(`output:${digest}`);
        if (!output || output.jobId !== authorization.jobId || output.digest !== digest) {
          throw new ApiError(403, "canonical-object-not-authorized", "Canonical object has not crossed the immutable persistence barrier.");
        }
        return this.r2Object(output.key, output.digest, output.bytes);
      }
      if (request.method === "PUT" && url.pathname.startsWith("/__forge/r2/output/") && authorization.kind === "validation") {
        const digest = url.pathname.slice("/__forge/r2/output/".length);
        if (!/^[0-9a-f]{64}$/.test(digest)) throw new ApiError(400, "output-digest-invalid", "Validation output digest is invalid.");
        const bytes = await readBoundedRequestBytes(request, MAX_VALIDATION_OUTPUT_BYTES);
        try {
          if (bytes.byteLength < 1 || await sha256Hex(bytes) !== digest) {
            throw new ApiError(400, "output-integrity", "Validation output does not match its content address.");
          }
          const key = `${authorization.outputPrefix}/${digest}`;
          const reference = { key, digest, bytes: bytes.byteLength } satisfies ClaimedObject;
          await claimImportObject(this.env, authorization.jobId, reference);
          const options = {
            httpMetadata: { contentType: request.headers.get("content-type") ?? "application/json" },
            customMetadata: { sha256: digest },
            sha256: Uint8Array.from(digest.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16)),
          } satisfies R2PutOptions;
          try {
            await putImmutableObject(this.env.JUDGE_BUCKET, key, bytes, digest, options);
          } catch (error) {
            await releaseImportObjectClaim(this.env, authorization.jobId, reference);
            throw error;
          }
          const output = { jobId: authorization.jobId, key, digest, bytes: bytes.byteLength } satisfies AuthorizedOutput;
          await this.ctx.storage.put(`output:${digest}`, output);
          return jsonResponse({ key, digest, bytes: bytes.byteLength }, 201);
        } finally {
          bytes.fill(0);
        }
      }
      if (request.method === "POST" && url.pathname === "/__forge/events" && authorization.kind === "submission") {
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
    } catch (error) {
      return apiErrorResponse(error);
    }
  }

  private async r2Object(key: string, expectedSha256?: string, expectedBytes?: number): Promise<Response> {
    const object = await this.env.JUDGE_BUCKET.get(key);
    if (!object) throw new ApiError(404, "r2-object-missing", "Authorized job object does not exist.");
    if (expectedSha256 && object.customMetadata?.sha256 !== expectedSha256) throw new ApiError(500, "r2-object-integrity", "Authorized job object metadata does not match its expected digest.");
    if (expectedBytes !== undefined && object.size !== expectedBytes) throw new ApiError(500, "r2-object-integrity", "Authorized job object length does not match its expected value.");
    const headers = new Headers({ "content-type": object.httpMetadata?.contentType ?? "application/octet-stream" });
    headers.set("content-length", String(object.size));
    if (object.checksums.sha256) headers.set("digest", `sha-256=${btoa(String.fromCharCode(...new Uint8Array(object.checksums.sha256)))}`);
    if (expectedSha256) headers.set("x-forge-sha256", expectedSha256);
    return new Response(object.body, { headers });
  }

}

function outboundFor(binding: "SUBMISSION_CONTAINER" | "VALIDATION_CONTAINER") {
  return {
    "forge-job.internal": async (request: Request, env: unknown, context: { readonly containerId: string }) => {
      const namespace = (env as ForgeWorkerEnv)[binding];
      const stub = namespace.get(namespace.idFromString(context.containerId));
      const target = new URL(request.url);
      target.protocol = "https:";
      target.hostname = "container.internal";
      target.pathname = `/__forge${target.pathname}`;
      return stub.fetch(new Request(target, request));
    },
  };
}

export class SubmissionJudgeContainer extends SecureJudgeContainer {
  protected readonly acceptedKind = "submission" as const;
}

export class ValidationJudgeContainer extends SecureJudgeContainer {
  protected readonly acceptedKind = "validation" as const;
}

SubmissionJudgeContainer.outboundByHost = outboundFor("SUBMISSION_CONTAINER");
ValidationJudgeContainer.outboundByHost = outboundFor("VALIDATION_CONTAINER");
