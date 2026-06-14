import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerDiscoveryTools } from "./discovery"
import { registerSourceTools } from "./source"
import { registerWriteTools } from "./write"
import { registerActivateTools } from "./activate"
import { registerQualityTools } from "./quality"
import { registerTransportTools } from "./transports"
import { registerDataTools } from "./data"
import { registerAnalysisTools } from "./analysis"
import { registerDebugTools } from "./debug"
import { registerTextElementTools } from "./textelements"
import { registerPackageTools } from "./packages"
import { registerTableDiscoveryTools } from "./tablediscovery"
import { registerCustomizingTools } from "./customizing"
import { registerCustomizingEngineTools } from "./customizingEngine"
import { wrapServerWithSessionRecovery } from "./sessionRecovery"

export function registerAllTools(server: McpServer): void {
  // Every handler registered below gets automatic forceReconnect-and-retry
  // on session-degradation errors (HTTP 400 after heavy use) — see
  // sessionRecovery.ts.
  const guarded = wrapServerWithSessionRecovery(server)
  registerDiscoveryTools(guarded)
  registerSourceTools(guarded)
  registerWriteTools(guarded)
  registerActivateTools(guarded)
  registerQualityTools(guarded)
  registerTransportTools(guarded)
  registerDataTools(guarded)
  registerAnalysisTools(guarded)
  registerDebugTools(guarded)
  registerTextElementTools(guarded)
  registerPackageTools(guarded)
  registerTableDiscoveryTools(guarded)
  registerCustomizingTools(guarded)
  registerCustomizingEngineTools(guarded)
}
