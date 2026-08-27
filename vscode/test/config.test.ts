import { describe, expect, it } from "vitest";
import { findApplication, parseConfig, resolveEndpoint, resolveToken } from "../src/config.js";

const configJson = JSON.stringify({
  defaultEnvironment: "staging",
  environments: {
    local: {
      token: "${env:SCRY_TOKEN}",
      requireConfirmation: false,
      targets: {
        accounts: { hosts: ["127.0.0.1"], port: 4321 },
      },
    },
    staging: {
      token: "literal",
      requireConfirmation: true,
      targets: {
        accounts: { hosts: ["10.0.0.20"], port: 4321 },
      },
    },
  },
  applications: [{ service: "accounts", paths: ["apps/accounts/**"] }],
});

describe("Scry config", () => {
  it("matches an application and resolves direct targets", () => {
    const config = parseConfig(configJson);
    const application = findApplication(config, "apps/accounts/lib/accounts.ex");
    const endpoint = resolveEndpoint(config, "local", application, { SCRY_TOKEN: "secret" });

    expect(application.service).toBe("accounts");
    expect(endpoint.hosts).toEqual(["127.0.0.1"]);
    expect(endpoint.token).toBe("secret");
  });

  it("resolves another environment", () => {
    const config = parseConfig(configJson);
    const application = findApplication(config, "apps/accounts/lib/accounts.ex");
    const endpoint = resolveEndpoint(config, "staging", application, {});

    expect(endpoint.hosts).toEqual(["10.0.0.20"]);
    expect(endpoint.requireConfirmation).toBe(true);
    expect(endpoint.token).toBe("literal");
  });

  it("fails when an environment token is missing", () => {
    expect(() => resolveToken("${env:SCRY_TOKEN}", {})).toThrow("SCRY_TOKEN");
  });
});
