import type { ApiHubClient } from "../api-hub/client.js";
import type { BugsnagClient } from "../bugsnag/client.js";

export interface ApiEndpoint {
  method: string;
  path: string;
  source: "bugsnag" | "api_hub";
}

export interface ApiDriftReport {
  bugsnag_only_endpoints: ApiEndpoint[];
  api_hub_only_endpoints: ApiEndpoint[];
  common_endpoints: ApiEndpoint[];
}

export class ApiDriftDetector {
  constructor(
    private bugsnagClient: BugsnagClient,
    private apiHubClient: ApiHubClient,
  ) {}

  /**
   * Extract HTTP endpoints from BugSnag span groups
   * @param spanGroups Array of span groups from BugSnag (network category)
   * @returns Array of API endpoints found in BugSnag
   */
  private extractBugsnagEndpoints(spanGroups: any[]): ApiEndpoint[] {
    const endpoints: ApiEndpoint[] = [];

    for (const spanGroup of spanGroups) {
      // First, try to extract from the structured properties if available
      if (spanGroup.properties?.network?.request) {
        const request = spanGroup.properties.network.request;
        if (request.http_method && request.endpoint) {
          const method = request.http_method.toUpperCase();
          const path = request.endpoint.startsWith('/') 
            ? request.endpoint 
            : `/${request.endpoint}`;
          
          endpoints.push({
            method,
            path: this.normalizePath(path),
            source: "bugsnag",
          });
          continue;
        }
      }

      // Fallback: Parse the span group name
      // Format: "[HTTP]localhost/api/todos|GET" or "GET /users"
      const name = spanGroup.name || "";
      
      // Try pattern: [HTTP]domain/path|METHOD
      let match = name.match(/\[HTTP\][^/]*\/(.+)\|(\w+)$/i);
      if (match) {
        const [, path, method] = match;
        endpoints.push({
          method: method.toUpperCase(),
          path: this.normalizePath(path),
          source: "bugsnag",
        });
        continue;
      }

      // Try pattern: METHOD /path
      match = name.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.+)$/i);
      if (match) {
        const [, method, path] = match;
        endpoints.push({
          method: method.toUpperCase(),
          path: this.normalizePath(path),
          source: "bugsnag",
        });
      }
    }

    // TEMPORARY: Filter out endpoints with empty paths (catch-all routes like /*)
    // These may be error handlers or fallback routes that should be handled differently
    const filteredEndpoints = endpoints.filter(endpoint => {
      return endpoint.path !== '' && endpoint.path !== '/*';
    });

    return this.deduplicateEndpoints(filteredEndpoints);
  }

  /**
   * Extract HTTP endpoints from API Hub definition
   * @param apiDefinition OpenAPI/Swagger specification
   * @returns Array of API endpoints found in API Hub
   */
  private extractApiHubEndpoints(apiDefinition: any): ApiEndpoint[] {
    const endpoints: ApiEndpoint[] = [];

    if (!apiDefinition || typeof apiDefinition !== "object") {
      return endpoints;
    }

    // Handle both OpenAPI 3.x and Swagger 2.x formats
    const paths = apiDefinition.paths || {};

    for (const path in paths) {
      const pathItem = paths[path];
      if (!pathItem || typeof pathItem !== "object") continue;

      // Check for HTTP methods
      const methods = ["get", "post", "put", "delete", "patch", "head", "options"];
      for (const method of methods) {
        if (pathItem[method]) {
          endpoints.push({
            method: method.toUpperCase(),
            path: this.normalizePath(path),
            source: "api_hub",
          });
        }
      }
    }

    return this.deduplicateEndpoints(endpoints);
  }

  /**
   * Normalize path format for comparison
   * @param path Raw path string
   * @returns Normalized path string
   */
  private normalizePath(path: string): string {
    // Remove leading/trailing whitespace and ensure it starts with /
    let normalized = path.trim();
    if (!normalized.startsWith("/")) {
      normalized = "/" + normalized;
    }

    // Normalize path parameters from various formats to standard {param} format
    // Only replace known parameter patterns, not just any path segment
    normalized = normalized
      .replace(/\{[^}]+\}/g, "{param}") // {id}, {userId} -> {param}
      .replace(/:[^/]+/g, "{param}"); // :id, :userId -> {param}

    // For actual endpoint calls with specific IDs (like /users/123), we need to be more careful
    // We'll only normalize paths that look like parameters, not actual data
    // Numbers alone in path segments are likely actual IDs from traced calls
    // So we convert them to {param} for comparison with OpenAPI paths
    normalized = normalized.replace(/\/\d+(?=\/|$)/g, "/{param}");

    // Remove trailing slash unless it's the root path
    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }

    return normalized;
  }

  /**
   * Remove duplicate endpoints based on method and path
   * @param endpoints Array of endpoints
   * @returns Deduplicated array of endpoints
   */
  private deduplicateEndpoints(endpoints: ApiEndpoint[]): ApiEndpoint[] {
    const seen = new Set<string>();
    return endpoints.filter((endpoint) => {
      const key = `${endpoint.method}:${endpoint.path}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  /**
   * Compare endpoints from BugSnag and API Hub to detect drift
   * @param bugsnagEndpoints Endpoints from BugSnag span groups
   * @param apiHubEndpoints Endpoints from API Hub definition
   * @returns API drift analysis report
   */
  private compareEndpoints(
    bugsnagEndpoints: ApiEndpoint[],
    apiHubEndpoints: ApiEndpoint[],
  ): ApiDriftReport {
    const bugsnagSet = new Set(
      bugsnagEndpoints.map((ep) => `${ep.method}:${ep.path}`),
    );
    const apiHubSet = new Set(
      apiHubEndpoints.map((ep) => `${ep.method}:${ep.path}`),
    );

    const bugsnagOnlyEndpoints: ApiEndpoint[] = [];
    const apiHubOnlyEndpoints: ApiEndpoint[] = [];
    const commonEndpoints: ApiEndpoint[] = [];

    // Find endpoints only in BugSnag
    for (const endpoint of bugsnagEndpoints) {
      const key = `${endpoint.method}:${endpoint.path}`;
      if (!apiHubSet.has(key)) {
        bugsnagOnlyEndpoints.push(endpoint);
      } else {
        commonEndpoints.push(endpoint);
      }
    }

    // Find endpoints only in API Hub
    for (const endpoint of apiHubEndpoints) {
      const key = `${endpoint.method}:${endpoint.path}`;
      if (!bugsnagSet.has(key)) {
        apiHubOnlyEndpoints.push(endpoint);
      }
    }

    return {
      bugsnag_only_endpoints: bugsnagOnlyEndpoints,
      api_hub_only_endpoints: apiHubOnlyEndpoints,
      common_endpoints: commonEndpoints,
    };
  }

  /**
   * Detect API drift between BugSnag span groups and API Hub definition
   * @param projectId BugSnag project ID
   * @param owner API Hub API owner
   * @param apiName API Hub API name
   * @param version API Hub API version
   * @returns API drift analysis report
   */
  async detectApiDrift(
    projectId: string,
    owner: string,
    apiName: string,
    version: string,
  ): Promise<ApiDriftReport> {
    // Get network span groups from BugSnag
    const bugsnagResponse = await this.bugsnagClient.listProjectSpanGroups(
      projectId,
      { category: "network" } // Focus on network category for HTTP requests
    );

    let spanGroups: any[] = [];
    if (bugsnagResponse && bugsnagResponse.body) {
      spanGroups = Array.isArray(bugsnagResponse.body) ? bugsnagResponse.body : [];
    }

    // Get API definition from API Hub
    const apiDefinition = await this.apiHubClient.getApiDefinition({
      owner,
      api: apiName,
      version,
      resolved: true, // Get resolved definition with all $refs included
    });

    // Extract endpoints from both sources
    const bugsnagEndpoints = this.extractBugsnagEndpoints(spanGroups);
    const apiHubEndpoints = this.extractApiHubEndpoints(apiDefinition);

    // Compare and generate drift report
    return this.compareEndpoints(bugsnagEndpoints, apiHubEndpoints);
  }

  /**
   * Format API drift report for human readable output
   * @param report API drift analysis report
   * @returns Formatted string report
   */
  formatDriftReport(report: ApiDriftReport): string {
    const lines: string[] = [];

    lines.push("API Drift Analysis Report");
    lines.push("=" .repeat(50));
    lines.push("");

    // Summary
    lines.push("Summary:");
    lines.push(`- Common endpoints: ${report.common_endpoints.length}`);
    lines.push(`- BugSnag only endpoints: ${report.bugsnag_only_endpoints.length}`);
    lines.push(`- API Hub only endpoints: ${report.api_hub_only_endpoints.length}`);
    lines.push("");

    // Endpoints only in BugSnag (potentially undocumented)
    if (report.bugsnag_only_endpoints.length > 0) {
      lines.push("Endpoints found in BugSnag but not in API Hub definition:");
      lines.push("-".repeat(60));
      for (const endpoint of report.bugsnag_only_endpoints) {
        lines.push(`  ${endpoint.method} ${endpoint.path}`);
      }
      lines.push("");
    }

    // Endpoints only in API Hub (potentially unused)
    if (report.api_hub_only_endpoints.length > 0) {
      lines.push("Endpoints found in API Hub definition but not in BugSnag:");
      lines.push("-".repeat(60));
      for (const endpoint of report.api_hub_only_endpoints) {
        lines.push(`  ${endpoint.method} ${endpoint.path}`);
      }
      lines.push("");
    }

    // Common endpoints
    if (report.common_endpoints.length > 0) {
      lines.push("Endpoints found in both BugSnag and API Hub:");
      lines.push("-".repeat(60));
      for (const endpoint of report.common_endpoints) {
        lines.push(`  ${endpoint.method} ${endpoint.path}`);
      }
      lines.push("");
    }

    if (report.bugsnag_only_endpoints.length === 0 && report.api_hub_only_endpoints.length === 0) {
      lines.push("✅ No API drift detected - all endpoints are synchronized.");
    } else {
      // Add recommended next steps based on findings
      lines.push("Recommended Next Steps:");
      lines.push("=".repeat(50));
      lines.push("");

      if (report.bugsnag_only_endpoints.length > 0) {
        lines.push("Recommended actions:");
        lines.push("");
        lines.push("1. Review and Update OpenAPI Document:");
        lines.push("   - Review the OpenAPI document and implementation code");
        lines.push("   - Add any newly discovered endpoints to the OpenAPI description");
        lines.push("   - Ensure the API definition accurately reflects production usage");
        lines.push("   - Publish a new version, ensuring to increment the version number first");
        lines.push("");
        lines.push("2. Review Consumer Pact Tests:");
        lines.push("   - Check test coverage for each undocumented endpoint (method, path)");
        lines.push("   - For missing scenarios, use SmartBear's MCP tools to generate Pact tests:");
        lines.push("     • Use 'generate_pact_tests' with request/response examples");
        lines.push("     • Include the updated OpenAPI document for context");
        lines.push("     • Ensure tests cover authentication, error scenarios, and edge cases");
        lines.push("");
      }
    }

    return lines.join("\n");
  }
}