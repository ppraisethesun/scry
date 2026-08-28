import { minimatch } from "minimatch";
import { z } from "zod";

const tokenSchema = z.string().min(1);
const hostsSchema = z.array(z.string().min(1)).min(1);

const endpointSchema = z.object({
  hosts: hostsSchema,
  port: z.number().int().min(1).max(65_535),
  token: tokenSchema.optional(),
}).strict();

const commonEnvironmentSchema = z.object({
  protocol: z.enum(["scry", "xrpc"]).default("scry"),
  requireConfirmation: z.boolean().default(false),
  token: tokenSchema,
  timeoutMs: z.number().int().positive().default(30_000),
}).strict();

const environmentSchema = commonEnvironmentSchema.extend({
  targets: z.record(endpointSchema),
});

const applicationSchema = z.object({
  service: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
}).strict();

export const scryConfigSchema = z
  .object({
    defaultEnvironment: z.string().min(1),
    environments: z.record(environmentSchema),
    applications: z.array(applicationSchema).min(1),
  })
  .strict()
  .superRefine((config, context) => {
    if (!(config.defaultEnvironment in config.environments)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultEnvironment"],
        message: `environment ${JSON.stringify(config.defaultEnvironment)} does not exist`,
      });
    }

    for (const [name, environment] of Object.entries(config.environments)) {
      for (const application of config.applications) {
        if (!(application.service in environment.targets)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["environments", name, "targets", application.service],
            message: `direct environment has no endpoint for ${application.service}`,
          });
        }
      }
    }
  });

export type ScryConfig = z.infer<typeof scryConfigSchema>;
export type ScryEnvironment = ScryConfig["environments"][string];
export type ScryApplication = ScryConfig["applications"][number];

export interface ResolvedEndpoint {
  environmentName: string;
  service: string;
  hosts: string[];
  port: number;
  token: string;
  timeoutMs: number;
  requireConfirmation: boolean;
  protocol: "scry" | "xrpc";
}

export function parseConfig(contents: string): ScryConfig {
  let value: unknown;

  try {
    value = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid .scry.json: ${message}`);
  }

  const result = scryConfigSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid .scry.json:\n${issues}`);
  }

  return result.data;
}

export function findApplication(config: ScryConfig, relativeFilePath: string): ScryApplication {
  const normalizedPath = relativeFilePath.replaceAll("\\", "/");
  const application = config.applications.find((candidate) =>
    candidate.paths.some((pattern) => minimatch(normalizedPath, pattern, { dot: true })),
  );

  if (!application) {
    throw new Error(`No Scry application matches ${JSON.stringify(normalizedPath)}`);
  }

  return application;
}

export function resolveEndpoint(
  config: ScryConfig,
  environmentName: string,
  application: ScryApplication,
  environmentVariables: NodeJS.ProcessEnv,
): ResolvedEndpoint {
  const environment = config.environments[environmentName];
  if (!environment) throw new Error(`Unknown Scry environment ${JSON.stringify(environmentName)}`);

  const target = environment.targets[application.service];
  if (!target) {
    throw new Error(
      `Environment ${JSON.stringify(environmentName)} has no endpoint for ${JSON.stringify(application.service)}`,
    );
  }

  return {
    environmentName,
    service: application.service,
    hosts: target.hosts,
    port: target.port,
    token: resolveToken(target.token ?? environment.token, environmentVariables),
    timeoutMs: environment.timeoutMs,
    requireConfirmation: environment.requireConfirmation,
    protocol: environment.protocol,
  };
}

export function resolveToken(value: string, environmentVariables: NodeJS.ProcessEnv): string {
  const match = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  if (!match) return value;

  const variableName = match[1];
  if (!variableName) throw new Error("Invalid token environment reference");

  const token = environmentVariables[variableName];
  if (!token) throw new Error(`Environment variable ${variableName} is not set`);
  return token;
}
