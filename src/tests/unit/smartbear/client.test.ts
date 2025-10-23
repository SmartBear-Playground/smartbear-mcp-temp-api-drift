import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiHubClient } from "../../../api-hub/client.js";
import type { BugsnagClient } from "../../../bugsnag/client.js";
import { SmartBearClient } from "../../../smartbear/client.js";

describe("SmartBearClient", () => {
  let bugsnagClient: BugsnagClient;
  let apiHubClient: ApiHubClient;
  let smartBearClient: SmartBearClient;
  let mockRegister: any;

  beforeEach(() => {
    // Create mock clients
    bugsnagClient = {
      listProjectSpanGroups: vi.fn(),
    } as any;

    apiHubClient = {
      getApiDefinition: vi.fn(),
    } as any;

    mockRegister = vi.fn();
    smartBearClient = new SmartBearClient(bugsnagClient, apiHubClient);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("construction", () => {
    it("should create client with correct properties", () => {
      expect(smartBearClient.name).toBe("SmartBear");
      expect(smartBearClient.prefix).toBe("smartbear");
    });
  });

  describe("detectApiDrift", () => {
    it("should detect API drift and return formatted report", async () => {
      // Mock BugSnag response
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
            category: "network",
            name: "POST /users/register",
            first_seen: "2025-01-01T00:00:00Z",
            last_seen: "2025-01-23T00:00:00Z",
            span_count: 50,
            error_count: 1,
            average_duration: 250,
            p95_duration: 500,
            p99_duration: 800,
          },
        ],
      };

      // Mock API Hub response
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
          "/users/profile": {
            get: {
              summary: "Get user profile",
              responses: { "200": { description: "Success" } },
            },
          },
        },
      };

      vi.mocked(bugsnagClient.listProjectSpanGroups).mockResolvedValue(mockBugsnagResponse);
      vi.mocked(apiHubClient.getApiDefinition).mockResolvedValue(mockApiDefinition);

      const result = await smartBearClient.detectApiDrift({
        projectId: "project123",
        owner: "org",
        apiName: "user-api",
        version: "1.0.0",
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("API Drift Analysis Report");
      expect(result).toContain("Common endpoints: 1");
      expect(result).toContain("BugSnag only endpoints: 1");
      expect(result).toContain("API Hub only endpoints: 1");
      expect(result).toContain("POST /users/register");
      expect(result).toContain("GET /users/profile");
      expect(result).toContain("GET /users");

      expect(bugsnagClient.listProjectSpanGroups).toHaveBeenCalledWith("project123", { category: "network" });
      expect(apiHubClient.getApiDefinition).toHaveBeenCalledWith({
        owner: "org",
        api: "user-api",
        version: "1.0.0",
        resolved: true,
      });
    });
  });

  describe("registerTools", () => {
    it("should register the detect API drift tool", () => {
      const mockGetInput = vi.fn();
      
      smartBearClient.registerTools(mockRegister, mockGetInput);

      expect(mockRegister).toHaveBeenCalledTimes(1);
      
      const [toolParams, handler] = mockRegister.mock.calls[0];
      
      expect(toolParams.title).toBe("Detect API Drift");
      expect(toolParams.summary).toContain("Compare network span groups from BugSnag");
      expect(toolParams.zodSchema).toBeDefined();
      expect(typeof handler).toBe("function");
    });

    it("should handle tool execution successfully", async () => {
      const mockGetInput = vi.fn();
      
      // Mock successful API responses
      const mockBugsnagResponse = {
        status: 200,
        headers: new Headers(),
        body: [],
      };
      const mockApiDefinition = { paths: {} };

      vi.mocked(bugsnagClient.listProjectSpanGroups).mockResolvedValue(mockBugsnagResponse);
      vi.mocked(apiHubClient.getApiDefinition).mockResolvedValue(mockApiDefinition);

      smartBearClient.registerTools(mockRegister, mockGetInput);

      const [, handler] = mockRegister.mock.calls[0];
      
      const result = await handler({
        projectId: "project123",
        owner: "org",
        apiName: "test-api",
        version: "1.0.0",
      }, {});

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("API Drift Analysis Report");
      expect(result.isError).toBeUndefined();
    });

    it("should handle tool execution errors", async () => {
      const mockGetInput = vi.fn();
      
      // Mock error response
      vi.mocked(bugsnagClient.listProjectSpanGroups).mockRejectedValue(new Error("BugSnag API error"));

      smartBearClient.registerTools(mockRegister, mockGetInput);

      const [, handler] = mockRegister.mock.calls[0];
      
      const result = await handler({
        projectId: "project123",
        owner: "org",
        apiName: "test-api",
        version: "1.0.0",
      }, {});

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("Error: BugSnag API error");
      expect(result.isError).toBe(true);
    });

    it("should prompt for parameters when not provided", async () => {
      const mockGetInput = vi.fn();
      
      // Mock getInput to return parameters
      mockGetInput.mockResolvedValue({
        projectId: "prompted-project",
        owner: "prompted-owner",
        apiName: "prompted-api",
        version: "prompted-version",
      });

      // Mock successful API responses
      vi.mocked(bugsnagClient.listProjectSpanGroups).mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: [],
      });
      vi.mocked(apiHubClient.getApiDefinition).mockResolvedValue({
        openapi: "3.0.0",
        paths: {},
      });

      smartBearClient.registerTools(mockRegister, mockGetInput);

      const [, handler] = mockRegister.mock.calls[0];
      
      // Call with empty arguments to trigger prompting
      await handler({}, {});

      // Verify getInput was called with correct schema
      expect(mockGetInput).toHaveBeenCalledWith({
        message: expect.stringContaining("Please provide the following parameters"),
        requestedSchema: expect.objectContaining({
          type: "object",
          properties: expect.objectContaining({
            projectId: expect.any(Object),
            owner: expect.any(Object),
            apiName: expect.any(Object),
            version: expect.any(Object),
          }),
          required: ["projectId", "owner", "apiName", "version"],
        }),
      });
    });

    it("should not prompt when all parameters are provided", async () => {
      const mockGetInput = vi.fn();
      
      // Mock successful API responses
      vi.mocked(bugsnagClient.listProjectSpanGroups).mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: [],
      });
      vi.mocked(apiHubClient.getApiDefinition).mockResolvedValue({
        openapi: "3.0.0",
        paths: {},
      });

      smartBearClient.registerTools(mockRegister, mockGetInput);

      const [, handler] = mockRegister.mock.calls[0];
      
      // Call with all parameters provided
      await handler({
        projectId: "test-project",
        owner: "test-owner",
        apiName: "test-api",
        version: "1.0.0",
      }, {});

      // Verify getInput was NOT called
      expect(mockGetInput).not.toHaveBeenCalled();
    });

    it("should prompt only for missing parameters", async () => {
      const mockGetInput = vi.fn();
      
      // Mock getInput to return only missing parameters
      mockGetInput.mockResolvedValue({
        apiName: "prompted-api",
        version: "prompted-version",
      });

      // Mock successful API responses
      vi.mocked(bugsnagClient.listProjectSpanGroups).mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: [],
      });
      vi.mocked(apiHubClient.getApiDefinition).mockResolvedValue({
        openapi: "3.0.0",
        paths: {},
      });

      smartBearClient.registerTools(mockRegister, mockGetInput);

      const [, handler] = mockRegister.mock.calls[0];
      
      // Call with partial parameters
      await handler({
        projectId: "test-project",
        owner: "test-owner",
      }, {});

      // Verify getInput was called with schema for missing parameters only
      expect(mockGetInput).toHaveBeenCalledWith({
        message: expect.stringContaining("apiName, version"),
        requestedSchema: expect.objectContaining({
          type: "object",
          properties: expect.objectContaining({
            apiName: expect.any(Object),
            version: expect.any(Object),
          }),
          required: ["apiName", "version"],
        }),
      });

      // Verify schema does NOT include already provided parameters
      const schema = mockGetInput.mock.calls[0][0].requestedSchema;
      expect(schema.properties).not.toHaveProperty("projectId");
      expect(schema.properties).not.toHaveProperty("owner");
    });
  });
});