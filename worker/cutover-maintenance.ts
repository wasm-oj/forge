function json(value: unknown, status: number): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

// Cloudflare requires a replacement version of the same Worker script to keep
// exporting every live Container and Workflow class, even while fetch traffic
// is temporarily served by the maintenance handler.
export { SubmissionJudgeContainer, ValidationJudgeContainer } from "./judge-container";
export { SubmissionWorkflow, ValidationWorkflow } from "./workflows";

const maintenanceWorker = {
  fetch(request: Request): Response {
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname === "/api/health/live") {
      return json({ ok: true, maintenance: true }, 200);
    }
    return json({
      error: {
        code: "deployment-maintenance",
        message: "Forge is briefly unavailable while the production data model is updated.",
      },
    }, 503);
  },
};

export default maintenanceWorker;
