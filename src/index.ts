#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { exec } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import path from "path";
import fs from "fs";

// Convert exec to use promises
const execAsync = promisify(exec);

// Configure screenshot resource directory
const SCREENSHOT_RESOURCE_DIR =
  process.env.SCREENSHOT_RESOURCE_DIR ||
  path.join(process.env.HOME || "", "Downloads", "ios-simulator-screenshots");

// Create the screenshot directory if it doesn't exist
if (!fs.existsSync(SCREENSHOT_RESOURCE_DIR)) {
  fs.mkdirSync(SCREENSHOT_RESOURCE_DIR, { recursive: true });
}

// Store screenshots in memory
const screenshots = new Map<string, string>();

// Initialize FastMCP server
const server = new McpServer({
  name: "ios-simulator",
  version: "1.0.0",
});

// Register new screenshots as they're created
function registerScreenshotResource(name: string, data: string) {
  screenshots.set(name, data);

  // Register a resource for this screenshot if it doesn't exist already
  server.resource(`screenshot-${name}`, `screenshot://${name}`, async (uri) => {
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "image/png",
          blob: data,
        },
      ],
    };
  });
}

// Add a resource to list available screenshots
server.resource("screenshot-list", "screenshot://list", async (uri) => {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "text/plain",
        text: Array.from(screenshots.keys()).join("\n"),
      },
    ],
  };
});

/**
 * Get the ID of the currently booted iOS simulator
 * @returns The details and UUID of the booted simulator, or a message if none is booted
 */
server.tool("get_booted_sim_id", {}, async () => {
  try {
    const { stdout } = await execAsync("xcrun simctl list devices");

    // Parse the output to find booted device
    const lines = stdout.split("\n");
    for (const line of lines) {
      if (line.includes("Booted")) {
        // Extract the UUID - it's inside parentheses
        const match = line.match(/\(([-0-9A-F]+)\)/);
        if (match) {
          const deviceId = match[1];
          const deviceName = line.split("(")[0].trim();
          return {
            content: [
              {
                type: "text",
                text: `Booted Simulator: ${deviceName}\nUUID: ${deviceId}`,
              },
            ],
          };
        }
      }
    }

    return {
      content: [{ type: "text", text: "No booted simulator found." }],
    };
  } catch (error: any) {
    return {
      content: [
        { type: "text", text: `Error: ${error.message || String(error)}` },
      ],
    };
  }
});

/**
 * Get a list of all available iOS simulators
 * @returns A formatted list of all simulators
 */
server.tool("get_all_simulators", {}, async () => {
  try {
    const { stdout } = await execAsync("xcrun simctl list devices");
    return {
      content: [{ type: "text", text: stdout }],
    };
  } catch (error: any) {
    return {
      content: [
        { type: "text", text: `Error: ${error.message || String(error)}` },
      ],
    };
  }
});

/**
 * Take a screenshot of a booted iOS simulator
 * @param deviceId The UUID of the simulator to screenshot
 * @param name Name for the screenshot (used for resource access)
 * @param outputPath Optional path where to save the screenshot (default: timestamp-based filename in the screenshot resource directory)
 * @returns Path to the saved screenshot or error message
 */
server.tool(
  "take_screenshot",
  {
    deviceId: z.string().describe("The UUID of the simulator to screenshot"),
    name: z
      .string()
      .optional()
      .describe("Name for the screenshot to be accessed as a resource"),
    outputPath: z
      .string()
      .optional()
      .describe("Optional path where to save the screenshot"),
  },
  async ({ deviceId, name, outputPath }) => {
    try {
      // Generate timestamp for name if not provided
      const screenshotName = name || `screenshot-${Date.now()}`;

      // Generate default filename with timestamp if no path provided
      const actualPath =
        outputPath ||
        path.join(SCREENSHOT_RESOURCE_DIR, `${screenshotName}.png`);

      // Ensure the directory exists
      const directory = path.dirname(actualPath);
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
      }

      // Take the screenshot
      await execAsync(`xcrun simctl io ${deviceId} screenshot "${actualPath}"`);

      // Get absolute path
      const absolutePath = path.resolve(actualPath);

      // Read the file and store it in memory as base64
      const imageBuffer = fs.readFileSync(actualPath);
      const base64Data = imageBuffer.toString("base64");

      // Register as a resource
      registerScreenshotResource(screenshotName, base64Data);

      return {
        content: [
          {
            type: "text",
            text: `Screenshot saved to: ${absolutePath}\nAccessible as resource: screenshot://${screenshotName}`,
          },
          {
            type: "image",
            data: base64Data,
            mimeType: "image/png",
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error taking screenshot: ${error.message || String(error)}`,
          },
        ],
      };
    }
  }
);

/**
 * Boot a specific simulator by ID
 * @param deviceId The UUID of the simulator to boot
 * @returns Result of the boot operation
 */
server.tool(
  "boot_simulator",
  { deviceId: z.string().describe("The UUID of the simulator to boot") },
  async ({ deviceId }) => {
    try {
      const { stdout } = await execAsync(`xcrun simctl boot ${deviceId}`);
      return {
        content: [
          {
            type: "text",
            text: `Successfully booted simulator with ID: ${deviceId}\n${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error booting simulator: ${error.message || String(error)}`,
          },
        ],
      };
    }
  }
);

/**
 * Delete a screenshot from the resource directory
 * @param name Name of the screenshot to delete
 * @returns Result of the deletion operation
 */
server.tool(
  "delete_screenshot",
  { name: z.string().describe("Name of the screenshot to delete") },
  async ({ name }) => {
    try {
      if (screenshots.has(name)) {
        screenshots.delete(name);
        return {
          content: [
            {
              type: "text",
              text: `Successfully deleted screenshot: ${name}`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Screenshot not found: ${name}`,
            },
          ],
        };
      }
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting screenshot: ${
              error.message || String(error)
            }`,
          },
        ],
      };
    }
  }
);

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);

process.stdin.on("close", () => {
  console.error("iOS Simulator MCP Server closed");
  server.close();
});
