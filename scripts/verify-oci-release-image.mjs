import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import {
  decodeCanonicalBase64,
  productionReleaseCoordinates,
} from "./configure-production-release.mjs";
import { resolveOciTag } from "./oci-release-image.mjs";

const run = promisify(execFile);

export function parseRegistryCredentials(bytes, expectedRegistryHost) {
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new TypeError("Wrangler returned invalid registry credential JSON.", { cause: error });
  }
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([
      "account_id", "password", "registry_host", "username",
    ])
    || typeof expectedRegistryHost !== "string"
    || expectedRegistryHost.length < 1
    || typeof value.account_id !== "string"
    || !/^[0-9a-f]{32}$/u.test(value.account_id)
    || value.registry_host !== expectedRegistryHost
    || typeof value.username !== "string"
    || value.username.length < 1
    || typeof value.password !== "string"
    || value.password.length < 1
  ) throw new TypeError("Wrangler returned invalid registry credential metadata.");
  return { password: value.password, username: value.username };
}

async function cloudflareRegistryCredentials(config, registry) {
  const { stdout } = await run("pnpm", [
    "exec", "wrangler", "containers", "registries", "credentials", registry,
    "--pull", "--json", "--config", config,
  ], {
    cwd: process.cwd(),
    encoding: "buffer",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 1024 * 1024,
  });
  return parseRegistryCredentials(stdout, registry);
}

function usage() {
  return `Usage: node scripts/verify-oci-release-image.mjs \\
  (--activation-request <canonical-request.json> | --activation-request-base64-env <environment-variable> | \\
   --reference <registry/repository:tag> --expected-digest <sha256:...>) \\
  --config <wrangler.quick-production.jsonc> --output-dir <directory> [--expected-git-commit <sha>]

The command obtains a short-lived pull credential through Wrangler, resolves the exact release tag,
and preserves the raw OCI manifest/config bytes plus canonical verification evidence.
`;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "activation-request": { type: "string" },
      "activation-request-base64-env": { type: "string" },
      config: { type: "string" },
      "expected-digest": { type: "string" },
      "expected-git-commit": { type: "string" },
      "output-dir": { type: "string" },
      reference: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  const activationSources = Number(Boolean(values["activation-request"])) + Number(Boolean(values["activation-request-base64-env"]));
  const directSource = Boolean(values.reference || values["expected-digest"]);
  if (
    (activationSources === 1 && directSource)
    || (activationSources === 0 && (!values.reference || !values["expected-digest"]))
    || activationSources > 1
  ) {
    throw new TypeError(`Use exactly one activation request source or one complete reference/digest pair.\n\n${usage()}`);
  }
  for (const key of ["config", "output-dir"]) {
    if (!values[key]) throw new TypeError(`--${key} is required.\n\n${usage()}`);
  }
  if (activationSources === 1 && !values["expected-git-commit"]) {
    throw new TypeError(`--expected-git-commit is required with an activation request.\n\n${usage()}`);
  }
  let reference;
  let expectedDigest;
  if (activationSources === 1) {
    const activationRequestBytes = values["activation-request"]
      ? await readFile(values["activation-request"])
      : decodeCanonicalBase64(
        process.env[values["activation-request-base64-env"]],
        values["activation-request-base64-env"],
      );
    const coordinates = productionReleaseCoordinates(activationRequestBytes, {
      expectedGitCommit: values["expected-git-commit"],
    });
    reference = coordinates.containerTag;
    expectedDigest = coordinates.containerDigest;
  } else {
    reference = values.reference;
    expectedDigest = values["expected-digest"];
  }
  const registry = new URL(`https://${reference}`).hostname;
  const credentials = await cloudflareRegistryCredentials(values.config, registry);
  const evidence = await resolveOciTag({
    reference,
    expectedDigest,
    credentials,
    outputDirectory: values["output-dir"],
  });
  process.stdout.write(`${JSON.stringify({
    digest: evidence.digest,
    evidencePath: path.join(values["output-dir"], "evidence.json"),
    platformDigest: evidence.platformDigest,
    reference: evidence.reference,
  })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
