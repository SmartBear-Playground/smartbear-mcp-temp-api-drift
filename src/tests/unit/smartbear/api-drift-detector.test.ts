import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiHubClient } from "../../../api-hub/client.js";
import type { BugsnagClient } from "../../../bugsnag/client.js";
import { ApiDriftDetector, type ApiDriftReport, type ApiEndpoint } from "../../../smartbear/api-drift-detector.js";

describe("ApiDriftDetector", () => {
  let bugsnagClient: BugsnagClient;
  let apiHubClient: ApiHubClient;
  let detector: ApiDriftDetector;

  beforeEach(() => {
    // Create mock clients
    bugsnagClient = {
      listProjectSpanGroups: vi.fn(),
    } as any;

    apiHubClient = {
      getApiDefinition: vi.fn(),
    } as any;

    detector = new ApiDriftDetector(bugsnagClient, apiHubClient);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("detectApiDrift", () => {
    it("should detect endpoints only in BugSnag", async () => {
      // Test extracting endpoints from BugSnag span groups
      const spanGroups = [
        {
          id: "1",
          category: "network",
          name: "GET /users",
          first_seen: "2025-01-01T00:00:00Z",
          last_seen: "2025-01-23T00:00:00Z",
          span_count: 100,
          error_count: 5,
          average_duration: 250,
          p95_duration: 500,
          p99_duration: 750,
        },
        {
          id: "2",
          category: "network",
          name: "POST /users/{param}/settings",
          first_seen: "2025-01-01T00:00:00Z",
          last_seen: "2025-01-23T00:00:00Z",
          span_count: 50,
          error_count: 2,
          average_duration: 300,
          p95_duration: 600,
          p99_duration: 900,
        },
      ];

      const mockBugsnagResponse = {
        status: 200,
        headers: new Headers(),
        body: spanGroups,
      };

      // Mock API Hub response with OpenAPI definition
      const mockApiDefinition = {
        openapi: "3.0.0",
        info: { title: "User API", version: "1.0.0" },
        paths: {
          "/users": {
            get: {
              summary: "List users",
              responses: { "200": { description: "Success" } },
            },
          },
        },
      };

      vi.mocked(bugsnagClient.listProjectSpanGroups).mockResolvedValue(mockBugsnagResponse);
      vi.mocked(apiHubClient.getApiDefinition).mockResolvedValue(mockApiDefinition);

      const result = await detector.detectApiDrift("project123", "org", "user-api", "1.0.0");

      expect(result.bugsnag_only_endpoints).toHaveLength(1);
      expect(result.bugsnag_only_endpoints[0]).toEqual({
        method: "POST",
        path: "/users/{param}/settings",
        source: "bugsnag",
      });

      expect(result.api_hub_only_endpoints).toHaveLength(0);

      expect(result.common_endpoints).toHaveLength(1);
      expect(result.common_endpoints[0]).toEqual({
        method: "GET",
        path: "/users",
        source: "bugsnag",
      });
    });

    it("should detect endpoints only in API Hub", async () => {
      // Mock BugSnag response with limited span groups
      const mockBugsnagResponse = {
        status: 200,
        headers: new Headers(),
        body: [
          {
            id: "1",
            category: "network",
            name: "GET /users",
            first_seen: "2025-01-01T00:00:00Z",
            last_seen: "2025-01-23T00:00:00Z",
            span_count: 100,
            error_count: 2,
            average_duration: 150,
            p95_duration: 300,
            p99_duration: 500,
          },
        ],
      };

      // Mock API Hub response with more endpoints
      const mockApiDefinition = {
        openapi: "3.0.0",
        info: { title: "User API", version: "1.0.0" },
        paths: {
          "/users": {
            get: {
              summary: "List users",
              responses: { "200": { description: "Success" } },
            },
            post: {
              summary: "Create user",
              responses: { "201": { description: "Created" } },
            },
          },
          "/users/{id}": {
            get: {
              summary: "Get user",
              responses: { "200": { description: "Success" } },
            },
            delete: {
              summary: "Delete user",
              responses: { "204": { description: "No content" } },
            },
          },
        },
      };

      vi.mocked(bugsnagClient.listProjectSpanGroups).mockResolvedValue(mockBugsnagResponse);
      vi.mocked(apiHubClient.getApiDefinition).mockResolvedValue(mockApiDefinition);

      const result = await detector.detectApiDrift("project123", "org", "user-api", "1.0.0");

      expect(result.bugsnag_only_endpoints).toHaveLength(0);

      expect(result.api_hub_only_endpoints).toHaveLength(3);
      expect(result.api_hub_only_endpoints).toEqual([
        { method: "POST", path: "/users", source: "api_hub" },
        { method: "GET", path: "/users/{param}", source: "api_hub" },
        { method: "DELETE", path: "/users/{param}", source: "api_hub" },
      ]);

      expect(result.common_endpoints).toHaveLength(1);
      expect(result.common_endpoints[0]).toEqual({
        method: "GET",
        path: "/users",
        source: "bugsnag",
      });
    });

    it("should handle empty responses", async () => {
      const mockBugsnagResponse = {
        status: 200,
        headers: new Headers(),
        body: [],
      };

      const mockApiDefinition = {
        openapi: "3.0.0",
        info: { title: "Empty API", version: "1.0.0" },
        paths: {},
      };

      vi.mocked(bugsnagClient.listProjectSpanGroups).mockResolvedValue(mockBugsnagResponse);
      vi.mocked(apiHubClient.getApiDefinition).mockResolvedValue(mockApiDefinition);

      const result = await detector.detectApiDrift("project123", "org", "empty-api", "1.0.0");

      expect(result.bugsnag_only_endpoints).toHaveLength(0);
      expect(result.api_hub_only_endpoints).toHaveLength(0);
      expect(result.common_endpoints).toHaveLength(0);
    });

    it("should normalize path parameters correctly", async () => {
      const mockBugsnagResponse = {
        status: 200,
        headers: new Headers(),
        body: [
          {
            id: "1",
            category: "network",
            name: "GET /api/v1/users/123",
            first_seen: "2025-01-01T00:00:00Z",
            last_seen: "2025-01-23T00:00:00Z",
            span_count: 50,
            error_count: 0,
            average_duration: 100,
            p95_duration: 200,
            p99_duration: 300,
          },
          {
            id: "2",
            category: "network",
            name: "POST /users/:userId/posts",
            first_seen: "2025-01-01T00:00:00Z",
            last_seen: "2025-01-23T00:00:00Z",
            span_count: 30,
            error_count: 1,
            average_duration: 200,
            p95_duration: 400,
            p99_duration: 600,
          },
        ],
      };

      const mockApiDefinition = {
        openapi: "3.0.0",
        paths: {
          "/api/v1/users/{id}": {
            get: { responses: { "200": { description: "Success" } } },
          },
          "/users/{userId}/posts": {
            post: { responses: { "201": { description: "Created" } } },
          },
        },
      };

      vi.mocked(bugsnagClient.listProjectSpanGroups).mockResolvedValue(mockBugsnagResponse);
      vi.mocked(apiHubClient.getApiDefinition).mockResolvedValue(mockApiDefinition);

      const result = await detector.detectApiDrift("project123", "org", "api", "1.0.0");

      expect(result.bugsnag_only_endpoints).toHaveLength(0);
      expect(result.api_hub_only_endpoints).toHaveLength(0);
      expect(result.common_endpoints).toHaveLength(2);
    });

    it("should filter out non-HTTP span groups", async () => {
      const mockBugsnagResponse = {
        status: 200,
        headers: new Headers(),
        body: [
          {
            id: "1",
            category: "network",
            name: "GET /users",
            first_seen: "2025-01-01T00:00:00Z",
            last_seen: "2025-01-23T00:00:00Z",
            span_count: 100,
            error_count: 0,
            average_duration: 150,
            p95_duration: 300,
            p99_duration: 500,
          },
          {
            id: "2",
            category: "db",
            name: "SELECT * FROM users",
            first_seen: "2025-01-01T00:00:00Z",
            last_seen: "2025-01-23T00:00:00Z",
            span_count: 200,
            error_count: 0,
            average_duration: 50,
            p95_duration: 100,
            p99_duration: 150,
          },
          {
            id: "3",
            category: "custom",
            name: "process_data",
            first_seen: "2025-01-01T00:00:00Z",
            last_seen: "2025-01-23T00:00:00Z",
            span_count: 50,
            error_count: 0,
            average_duration: 250,
            p95_duration: 500,
            p99_duration: 750,
          },
        ],
      };

      const mockApiDefinition = {
        openapi: "3.0.0",
        paths: {},
      };

      vi.mocked(bugsnagClient.listProjectSpanGroups).mockResolvedValue(mockBugsnagResponse);
      vi.mocked(apiHubClient.getApiDefinition).mockResolvedValue(mockApiDefinition);

      const result = await detector.detectApiDrift("project123", "org", "api", "1.0.0");

      expect(result.bugsnag_only_endpoints).toHaveLength(1);
      expect(result.bugsnag_only_endpoints[0].method).toBe("GET");
      expect(result.bugsnag_only_endpoints[0].path).toBe("/users");
    });
  });

  describe("formatDriftReport", () => {
    it("should format a comprehensive drift report", () => {
      const report: ApiDriftReport = {
        bugsnag_only_endpoints: [
          { method: "POST", path: "/users/{param}/verify", source: "bugsnag" },
          { method: "DELETE", path: "/cache/clear", source: "bugsnag" },
        ],
        api_hub_only_endpoints: [
          { method: "GET", path: "/users/{param}/profile", source: "api_hub" },
          { method: "PUT", path: "/users/{param}", source: "api_hub" },
        ],
        common_endpoints: [
          { method: "GET", path: "/users", source: "bugsnag" },
          { method: "POST", path: "/users", source: "bugsnag" },
        ],
      };

      const formatted = detector.formatDriftReport(report);

      expect(formatted).toContain("API Drift Analysis Report");
      expect(formatted).toContain("Summary:");
      expect(formatted).toContain("Common endpoints: 2");
      expect(formatted).toContain("BugSnag only endpoints: 2");
      expect(formatted).toContain("API Hub only endpoints: 2");
      expect(formatted).toContain("POST /users/{param}/verify");
      expect(formatted).toContain("DELETE /cache/clear");
      expect(formatted).toContain("GET /users/{param}/profile");
      expect(formatted).toContain("PUT /users/{param}");
      expect(formatted).toContain("GET /users");
      expect(formatted).toContain("POST /users");
      expect(formatted).toContain("Endpoints found in BugSnag but not in API Hub definition:");
      expect(formatted).toContain("Endpoints found in API Hub definition but not in BugSnag:");
      expect(formatted).toContain("Endpoints found in both BugSnag and API Hub:");
    });

    it("should show no drift message when endpoints are synchronized", () => {
      const report: ApiDriftReport = {
        bugsnag_only_endpoints: [],
        api_hub_only_endpoints: [],
        common_endpoints: [
          { method: "GET", path: "/users", source: "bugsnag" },
          { method: "POST", path: "/users", source: "bugsnag" },
        ],
      };

      const formatted = detector.formatDriftReport(report);

      expect(formatted).toContain("✅ No API drift detected - all endpoints are synchronized.");
      expect(formatted).toContain("Common endpoints: 2");
      expect(formatted).toContain("BugSnag only endpoints: 0");
      expect(formatted).toContain("API Hub only endpoints: 0");
    });

    it("should handle empty report", () => {
      const report: ApiDriftReport = {
        bugsnag_only_endpoints: [],
        api_hub_only_endpoints: [],
        common_endpoints: [],
      };

      const formatted = detector.formatDriftReport(report);

      expect(formatted).toContain("API Drift Analysis Report");
      expect(formatted).toContain("Common endpoints: 0");
      expect(formatted).toContain("BugSnag only endpoints: 0");
      expect(formatted).toContain("API Hub only endpoints: 0");
      expect(formatted).toContain("✅ No API drift detected - all endpoints are synchronized.");
    });
  });

  describe("endpoint extraction", () => {
    it("should extract endpoints from various span group name formats", async () => {
      const mockBugsnagResponse = {
        status: 200,
        headers: new Headers(),
        body: [
          { 
            id: "1",
            category: "network", 
            name: "GET /api/users",
            first_seen: "2025-01-01T00:00:00Z",
            last_seen: "2025-01-23T00:00:00Z",
            span_count: 100,
            error_count: 0,
            average_duration: 150,
            p95_duration: 300,
            p99_duration: 500,
          },
          { 
            id: "2",
            category: "network", 
            name: "POST /api/v1/users/{id}",
            first_seen: "2025-01-01T00:00:00Z",
            last_seen: "2025-01-23T00:00:00Z",
            span_count: 50,
            error_count: 1,
            average_duration: 250,
            p95_duration: 500,
            p99_duration: 800,
          },
          { 
            id: "3",
            category: "network", 
            name: "put /users/profile",
            first_seen: "2025-01-01T00:00:00Z",
            last_seen: "2025-01-23T00:00:00Z",
            span_count: 30,
            error_count: 0,
            average_duration: 180,
            p95_duration: 360,
            p99_duration: 540,
          }, // lowercase
          { 
            id: "4",
            category: "network", 
            name: "DELETE /admin/users/123/disable",
            first_seen: "2025-01-01T00:00:00Z",
            last_seen: "2025-01-23T00:00:00Z",
            span_count: 10,
            error_count: 0,
            average_duration: 300,
            p95_duration: 600,
            p99_duration: 900,
          },
          { 
            id: "5",
            category: "network", 
            name: "PATCH /users",
            first_seen: "2025-01-01T00:00:00Z",
            last_seen: "2025-01-23T00:00:00Z",
            span_count: 20,
            error_count: 0,
            average_duration: 200,
            p95_duration: 400,
            p99_duration: 600,
          },
          { 
            id: "6",
            category: "network", 
            name: "invalid format",
            first_seen: "2025-01-01T00:00:00Z",
            last_seen: "2025-01-23T00:00:00Z",
            span_count: 5,
            error_count: 0,
            average_duration: 100,
            p95_duration: 200,
            p99_duration: 300,
          }, // should be ignored
          { 
            id: "7",
            category: "network", 
            name: "GET /external/api",
            first_seen: "2025-01-01T00:00:00Z",
            last_seen: "2025-01-23T00:00:00Z",
            span_count: 15,
            error_count: 0,
            average_duration: 500,
            p95_duration: 1000,
            p99_duration: 1500,
          }, // network category
        ],
      };

      const mockApiDefinition = { paths: {} };

      vi.mocked(bugsnagClient.listProjectSpanGroups).mockResolvedValue(mockBugsnagResponse);
      vi.mocked(apiHubClient.getApiDefinition).mockResolvedValue(mockApiDefinition);

      const result = await detector.detectApiDrift("project123", "org", "api", "1.0.0");

      expect(result.bugsnag_only_endpoints).toHaveLength(6);
      
      const methods = result.bugsnag_only_endpoints.map((ep: ApiEndpoint) => ep.method);
      expect(methods).toContain("GET");
      expect(methods).toContain("POST");
      expect(methods).toContain("PUT");
      expect(methods).toContain("DELETE");
      expect(methods).toContain("PATCH");
      
      const paths = result.bugsnag_only_endpoints.map((ep: ApiEndpoint) => ep.path);
      expect(paths).toContain("/api/users");
      expect(paths).toContain("/api/v1/users/{param}");
      expect(paths).toContain("/users/profile");
      expect(paths).toContain("/admin/users/{param}/disable");
      expect(paths).toContain("/external/api");
    });
  });
});