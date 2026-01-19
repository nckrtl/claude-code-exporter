import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { hostname } from "os";

const CLAUDE_DATA_DIR = process.env.CLAUDE_DATA_DIR || "/home/nckrtl/.claude";
const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4317";
const EXPORT_INTERVAL = parseInt(process.env.EXPORT_INTERVAL || "10000", 10);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "30000", 10);
const INSTANCE_ID = process.env.INSTANCE_ID || hostname();

console.log(`Claude Code Metrics Exporter starting...`);
console.log(`Claude data dir: ${CLAUDE_DATA_DIR}`);
console.log(`OTLP Endpoint: ${OTEL_ENDPOINT}`);
console.log(`Instance ID: ${INSTANCE_ID}`);

// Set up OpenTelemetry
const resource = new Resource({
  [ATTR_SERVICE_NAME]: "claude-code",
  [ATTR_SERVICE_VERSION]: "1.0.0",
  "service.instance.id": INSTANCE_ID,
});

const metricExporter = new OTLPMetricExporter({
  url: OTEL_ENDPOINT,
});

const meterProvider = new MeterProvider({
  resource,
  readers: [
    new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: EXPORT_INTERVAL,
    }),
  ],
});

const meter = meterProvider.getMeter("claude-code-metrics");

// Current metric values (updated by polling)
let currentMetrics = {
  sessionCount: 0,
  messageCount: 0,
  toolCallCount: 0,
  tokensByModel: {},      // model -> {input, output, cacheRead, cacheWrite}
  costByModel: {},        // model -> USD
  activeSessionCount: 0,
};

// Observable gauges for cumulative totals (these report current values, not deltas)
const sessionCountGauge = meter.createObservableGauge("claude.code.session.count", {
  description: "Total count of Claude Code sessions",
  unit: "1",
});

const messageCountGauge = meter.createObservableGauge("claude.code.message.count", {
  description: "Total count of messages",
  unit: "1",
});

const toolCallCountGauge = meter.createObservableGauge("claude.code.tool.usage", {
  description: "Total count of tool calls",
  unit: "1",
});

const tokenUsageGauge = meter.createObservableGauge("claude.code.token.usage", {
  description: "Token usage by type and model",
  unit: "tokens",
});

const costUsageGauge = meter.createObservableGauge("claude.code.cost.usage", {
  description: "Cost in USD by model",
  unit: "USD",
});

const activeSessionsGauge = meter.createObservableGauge("claude.code.session.active", {
  description: "Number of active sessions",
  unit: "1",
});

const sessionInfoGauge = meter.createObservableGauge("claude.code.session.info", {
  description: "Active session information with metadata",
  unit: "1",
});

// Track active sessions for info gauge
let activeSessions = []; // Array of {sessionId, title, project, modified}

// Register callbacks
meter.addBatchObservableCallback(
  (batchObservableResult) => {
    // Report totals
    batchObservableResult.observe(sessionCountGauge, currentMetrics.sessionCount, {
      source: INSTANCE_ID,
    });
    
    batchObservableResult.observe(messageCountGauge, currentMetrics.messageCount, {
      source: INSTANCE_ID,
    });
    
    batchObservableResult.observe(toolCallCountGauge, currentMetrics.toolCallCount, {
      source: INSTANCE_ID,
    });
    
    batchObservableResult.observe(activeSessionsGauge, currentMetrics.activeSessionCount, {
      source: INSTANCE_ID,
    });
    
    // Report tokens by model and type
    for (const [model, tokens] of Object.entries(currentMetrics.tokensByModel)) {
      if (tokens.input > 0) {
        batchObservableResult.observe(tokenUsageGauge, tokens.input, {
          type: "input",
          model,
          source: INSTANCE_ID,
        });
      }
      if (tokens.output > 0) {
        batchObservableResult.observe(tokenUsageGauge, tokens.output, {
          type: "output",
          model,
          source: INSTANCE_ID,
        });
      }
      if (tokens.cacheRead > 0) {
        batchObservableResult.observe(tokenUsageGauge, tokens.cacheRead, {
          type: "cacheRead",
          model,
          source: INSTANCE_ID,
        });
      }
      if (tokens.cacheWrite > 0) {
        batchObservableResult.observe(tokenUsageGauge, tokens.cacheWrite, {
          type: "cacheCreation",
          model,
          source: INSTANCE_ID,
        });
      }
    }
    
    // Report cost by model
    for (const [model, cost] of Object.entries(currentMetrics.costByModel)) {
      if (cost > 0) {
        batchObservableResult.observe(costUsageGauge, cost, {
          model,
          source: INSTANCE_ID,
        });
      }
    }
    
    // Report active session info
    for (const session of activeSessions) {
      batchObservableResult.observe(sessionInfoGauge, 1, {
        session_id: session.sessionId,
        title: session.title || "",
        directory: session.project || "",
        source: INSTANCE_ID,
      });
    }
  },
  [sessionCountGauge, messageCountGauge, toolCallCountGauge, tokenUsageGauge, costUsageGauge, activeSessionsGauge, sessionInfoGauge]
);

function readStatsCache() {
  const statsPath = join(CLAUDE_DATA_DIR, "stats-cache.json");
  
  if (!existsSync(statsPath)) {
    console.log(`Stats file not found: ${statsPath}`);
    return null;
  }
  
  try {
    const content = readFileSync(statsPath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    console.error(`Error reading stats cache: ${error.message}`);
    return null;
  }
}

const ACTIVE_SESSION_HOURS = parseInt(process.env.ACTIVE_SESSION_HOURS || "1", 10);

function getActiveSessions() {
  // Read sessions-index.json from each project directory
  // Count sessions modified within the active window as "active"
  const projectsDir = join(CLAUDE_DATA_DIR, "projects");
  if (!existsSync(projectsDir)) return [];
  
  const activeWindowMs = ACTIVE_SESSION_HOURS * 60 * 60 * 1000;
  const cutoffTime = Date.now() - activeWindowMs;
  const sessions = [];
  
  try {
    const projects = readdirSync(projectsDir);
    for (const project of projects) {
      const projectPath = join(projectsDir, project);
      const indexPath = join(projectPath, "sessions-index.json");
      
      if (!existsSync(indexPath)) continue;
      
      try {
        const content = readFileSync(indexPath, "utf8");
        const index = JSON.parse(content);
        
        if (!index.entries || !Array.isArray(index.entries)) continue;
        
        for (const entry of index.entries) {
          // Check if session was modified within the active window
          const modifiedTime = new Date(entry.modified).getTime();
          if (modifiedTime > cutoffTime) {
            sessions.push({
              sessionId: entry.sessionId,
              title: entry.firstPrompt ? entry.firstPrompt.slice(0, 100) : "",
              project: entry.projectPath || project,
              modified: entry.modified,
              messageCount: entry.messageCount || 0,
            });
          }
        }
      } catch (e) {
        // Skip projects with invalid index files
      }
    }
  } catch (error) {
    console.error(`Error reading active sessions: ${error.message}`);
  }
  
  // Sort by most recently modified
  sessions.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  
  return sessions;
}

function updateMetrics() {
  const stats = readStatsCache();
  
  if (!stats) {
    console.log("No stats available");
    return;
  }
  
  // Update basic counts
  currentMetrics.sessionCount = stats.totalSessions || 0;
  currentMetrics.messageCount = stats.totalMessages || 0;
  
  // Calculate total tool calls from daily activity
  let totalToolCalls = 0;
  if (stats.dailyActivity) {
    for (const day of stats.dailyActivity) {
      totalToolCalls += day.toolCallCount || 0;
    }
  }
  currentMetrics.toolCallCount = totalToolCalls;
  
  // Update token usage by model
  currentMetrics.tokensByModel = {};
  currentMetrics.costByModel = {};
  
  if (stats.modelUsage) {
    for (const [model, usage] of Object.entries(stats.modelUsage)) {
      currentMetrics.tokensByModel[model] = {
        input: usage.inputTokens || 0,
        output: usage.outputTokens || 0,
        cacheRead: usage.cacheReadInputTokens || 0,
        cacheWrite: usage.cacheCreationInputTokens || 0,
      };
      
      if (usage.costUSD > 0) {
        currentMetrics.costByModel[model] = usage.costUSD;
      }
    }
  }
  
  // Get active sessions (modified within last N hours)
  activeSessions = getActiveSessions();
  currentMetrics.activeSessionCount = activeSessions.length;
  
  // Log summary
  const totalTokens = Object.values(currentMetrics.tokensByModel).reduce(
    (sum, t) => sum + t.input + t.output + t.cacheRead + t.cacheWrite, 0
  );
  
  console.log(`Updated metrics: ${currentMetrics.sessionCount} sessions, ${currentMetrics.messageCount} messages, ${totalTokens.toLocaleString()} tokens, ${currentMetrics.toolCallCount} tool calls, ${currentMetrics.activeSessionCount} active`);
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  await meterProvider.shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  await meterProvider.shutdown();
  process.exit(0);
});

// Start
console.log("Starting metrics collection...");
updateMetrics();

// Poll for updates
setInterval(updateMetrics, POLL_INTERVAL);
console.log(`Polling every ${POLL_INTERVAL}ms`);
