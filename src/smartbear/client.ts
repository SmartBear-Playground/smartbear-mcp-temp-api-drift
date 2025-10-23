import { z } from "zod";
import type {
  Client,
  GetInputFunction,
  RegisterToolsFunction,
} from "../common/types.js";
import type { ApiHubClient } from "../api-hub/client.js";
import type { BugsnagClient } from "../bugsnag/client.js";
import { ApiDriftDetector } from "./api-drift-detector.js";

// Zod schema for API drift detection parameters
const ApiDriftParamsSchema = z.object({
  projectId: z
    .string()
    .describe("BugSnag project ID to analyze span groups for"),
  owner: z
    .string()
    .describe("API Hub API owner (organization or username)"),
  apiName: z
    .string()
    .describe("API Hub API name to compare against"),
  version: z
    .string()
    .describe("API Hub API version to compare against"),
});

type ApiDriftParams = z.infer<typeof ApiDriftParamsSchema>;

export interface SmartBearToolParams {
  title: string;
  summary: string;
  zodSchema: z.ZodType<any>;
  handler: string;
  formatResponse?: (result: any) => string;
}

export const TOOLS: SmartBearToolParams[] = [
  {
    title: "Detect API Drift",
    summary:
      "Compare network span groups from BugSnag with API Hub definition to detect API drift. Analyzes HTTP endpoints found in BugSnag performance traces (network category) against documented API endpoints in API Hub, identifying undocumented endpoints, unused endpoints, and synchronization issues.\n\n**Interactive Tool**: This tool will prompt you for the required parameters if they are not provided.\n\n**Parameters:**\n- projectId (string) *required*: BugSnag project ID to analyze span groups for\n- owner (string) *required*: API Hub API owner (organization or username)\n- apiName (string) *required*: API Hub API name to compare against\n- version (string) *required*: API Hub API version to compare against\n\n**Output Format:** Human-readable report listing endpoint differences between BugSnag traces and API Hub documentation\n\n**Use Cases:** 1. Identify undocumented API endpoints that appear in production traffic 2. Find documented endpoints that may not be in use 3. Maintain API documentation synchronization with actual usage 4. Support API governance and compliance efforts\n\n**Examples:**\n1. Detect drift for a REST API\n```json\n{\n  \"projectId\": \"507f1f77bcf86cd799439011\",\n  \"owner\": \"my-org\",\n  \"apiName\": \"user-service\",\n  \"version\": \"1.0.0\"\n}\n```\nExpected Output: Structured report showing endpoints found only in BugSnag, only in API Hub, and common endpoints\n\n**Hints:** 1. Ensure both BugSnag and API Hub contain relevant data for accurate comparison 2. Use resolved API definitions for complete endpoint coverage 3. Network span groups from BugSnag provide actual production usage patterns 4. Tool analyzes 'network' category span groups for API endpoint analysis 5. If parameters are not provided, the tool will interactively prompt for them",
    zodSchema: ApiDriftParamsSchema,
    handler: "detectApiDrift",
    formatResponse: (result) => result, // Already formatted by the detector
  },
];

export class SmartBearClient implements Client {
  private apiDriftDetector: ApiDriftDetector;

  name = "SmartBear";
  prefix = "smartbear";

  constructor(
    private bugsnagClient: BugsnagClient,
    private apiHubClient: ApiHubClient,
  ) {
    this.apiDriftDetector = new ApiDriftDetector(bugsnagClient, apiHubClient);
  }

  async detectApiDrift(args: ApiDriftParams): Promise<string> {
    const report = await this.apiDriftDetector.detectApiDrift(
      args.projectId,
      args.owner,
      args.apiName,
      args.version,
    );
    return this.apiDriftDetector.formatDriftReport(report);
  }

  private async promptForApiDriftParameters(
    getInput: GetInputFunction,
    existingArgs: any,
  ): Promise<ApiDriftParams> {
    // If all parameters are already provided, return them
    if (existingArgs.projectId && existingArgs.owner && existingArgs.apiName && existingArgs.version) {
      return existingArgs as ApiDriftParams;
    }

    // Prompt for missing parameters
    const missingParams: string[] = [];
    if (!existingArgs.projectId) missingParams.push("projectId");
    if (!existingArgs.owner) missingParams.push("owner");
    if (!existingArgs.apiName) missingParams.push("apiName");
    if (!existingArgs.version) missingParams.push("version");

    const properties: any = {};
    const required: string[] = [];

    if (!existingArgs.projectId) {
      properties.projectId = {
        type: "string",
        title: "BugSnag Project ID",
        description: "The BugSnag project ID to analyze span groups for",
      };
      required.push("projectId");
    }

    if (!existingArgs.owner) {
      properties.owner = {
        type: "string",
        title: "API Hub Owner",
        description: "API Hub API owner (organization or username)",
      };
      required.push("owner");
    }

    if (!existingArgs.apiName) {
      properties.apiName = {
        type: "string",
        title: "API Name",
        description: "API Hub API name to compare against",
      };
      required.push("apiName");
    }

    if (!existingArgs.version) {
      properties.version = {
        type: "string",
        title: "API Version",
        description: "API Hub API version to compare against",
      };
      required.push("version");
    }

    const result = await getInput({
      message: `Please provide the following parameters for API drift detection: ${missingParams.join(", ")}`,
      requestedSchema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    });

    return {
      projectId: existingArgs.projectId || result.projectId,
      owner: existingArgs.owner || result.owner,
      apiName: existingArgs.apiName || result.apiName,
      version: existingArgs.version || result.version,
    };
  }

  registerTools(
    register: RegisterToolsFunction,
    getInput: GetInputFunction,
  ): void {
    TOOLS.forEach((tool) => {
      const { handler, formatResponse, ...toolParams } = tool;
      register(toolParams, async (args, _extra) => {
        try {
          let finalArgs = args;

          // For API drift detection, always prompt for parameters
          if (handler === "detectApiDrift") {
            finalArgs = await this.promptForApiDriftParameters(getInput, args);
          }

          // Dynamic method invocation
          const handlerFn = (this as any)[handler];
          if (typeof handlerFn !== "function") {
            throw new Error(`Handler '${handler}' not found on SmartBearClient`);
          }

          const result = await handlerFn.call(this, finalArgs);

          // Use custom formatter if available, otherwise return JSON
          const formattedResult = formatResponse
            ? formatResponse(result)
            : result;
          const responseText =
            typeof formattedResult === "string"
              ? formattedResult
              : JSON.stringify(formattedResult);

          return {
            content: [{ type: "text", text: responseText }],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      });
    });
  }
}