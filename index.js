import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { hostname, homedir } from "os";

// Auto-detect Claude data directory (works on Mac and Linux)
const DEFAULT_CLAUDE_DIR = join(homedir(), ".claude");
const CLAUDE_DATA_DIR = process.env.CLAUDE_DATA_DIR || DEFAULT_CLAUDE_DIR;
const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4317";
const EXPORT_INTERVAL = parseInt(process.env.EXPORT_INTERVAL || "10000", 10);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "30000", 10);
const INSTANCE_ID = process.env.INSTANCE_ID || hostname();

console.log(`Claude Code Metrics Exporter starting...`);
console.log(`Claude data dir: ${CLAUDE_DATA_DIR}`);
console.log(`OTLP Endpoint: ${OTEL_ENDPOINT}`);
console.log(`Instance ID: ${INSTANCE_ID}`);

// Set up OpenTelemetry
// Use distinct service name to avoid conflicts with Claude Code's native telemetry
const resource = new Resource({
  [ATTR_SERVICE_NAME]: "claude-code-stats",
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

// Active time tracking - cumulative counter (monotonically increasing)
let lastPollTime = null;
let wasActiveLastPoll = false;
let cumulativeActiveTimeSeconds = 0; // Total ever, persisted
let previousActiveTimeSeconds = 0; // For calculating counter deltas

// Persistence file for active time (survives restarts)
const ACTIVE_TIME_FILE = join(CLAUDE_DATA_DIR, ".exporter-active-time.json");

// Persistence file for seen conversations (for time-range aware counting)
const SEEN_CONVERSATIONS_FILE = join(CLAUDE_DATA_DIR, ".exporter-seen-conversations.json");
let seenConversationIds = new Set();

function loadActiveTimeState() {
  try {
    if (existsSync(ACTIVE_TIME_FILE)) {
      const content = readFileSync(ACTIVE_TIME_FILE, "utf8");
      const state = JSON.parse(content);
      cumulativeActiveTimeSeconds = state.cumulativeSeconds || 0;
      lastPollTime = state.lastPollTime || null;
      console.log(`Loaded cumulative active time: ${cumulativeActiveTimeSeconds}s`);
    }
  } catch (e) {
    console.log(`Could not load active time state: ${e.message}`);
  }
  // Initialize the counter's previous value to match loaded state
  // This will be set properly after the meter is created
}

function saveActiveTimeState() {
  try {
    writeFileSync(ACTIVE_TIME_FILE, JSON.stringify({ 
      cumulativeSeconds: cumulativeActiveTimeSeconds,
      lastPollTime: lastPollTime
    }), "utf8");
  } catch (e) {
    console.error(`Failed to save active time state: ${e.message}`);
  }
}

function loadSeenConversations() {
  try {
    if (existsSync(SEEN_CONVERSATIONS_FILE)) {
      const content = readFileSync(SEEN_CONVERSATIONS_FILE, "utf8");
      const state = JSON.parse(content);
      seenConversationIds = new Set(state.ids || []);
      console.log(`Loaded ${seenConversationIds.size} seen conversation IDs`);
    }
  } catch (e) {
    console.log(`Could not load seen conversations: ${e.message}`);
  }
}

function saveSeenConversations() {
  try {
    writeFileSync(SEEN_CONVERSATIONS_FILE, JSON.stringify({ 
      ids: Array.from(seenConversationIds),
      lastUpdated: new Date().toISOString()
    }), "utf8");
  } catch (e) {
    console.error(`Failed to save seen conversations: ${e.message}`);
  }
}

function updateActiveTime(hasActiveSessions) {
  const now = Date.now();
  
  // If active and we have a previous poll time, add the delta
  if (hasActiveSessions && wasActiveLastPoll && lastPollTime !== null) {
    const deltaSeconds = Math.round((now - lastPollTime) / 1000);
    if (deltaSeconds > 0) {
      cumulativeActiveTimeSeconds += deltaSeconds;
      console.log(`Active time: +${deltaSeconds}s (total: ${cumulativeActiveTimeSeconds}s)`);
    }
  }
  
  wasActiveLastPoll = hasActiveSessions;
  lastPollTime = now;
  
  // Save state periodically
  saveActiveTimeState();
}

// Counters for cumulative metrics - use "stats" prefix to avoid conflicts with native telemetry
const sessionCounter = meter.createCounter("claude.code.stats.session.count", {
  description: "Total count of Claude Code sessions (from stats cache)",
  unit: "1",
});

const messageCounter = meter.createCounter("claude.code.stats.message.count", {
  description: "Total count of messages (from stats cache)",
  unit: "1",
});

const toolCallCounter = meter.createCounter("claude.code.stats.tool.usage", {
  description: "Total count of tool calls (from stats cache)",
  unit: "1",
});

const tokenCounter = meter.createCounter("claude.code.stats.token.usage", {
  description: "Token usage by type and model (from stats cache)",
  unit: "tokens",
});

const costCounter = meter.createCounter("claude.code.stats.cost.usage", {
  description: "Cost in USD by model (from stats cache)",
  unit: "USD",
});

// Gauges for point-in-time values - use "stats" prefix to avoid conflicts
const activeSessionsGauge = meter.createObservableGauge("claude.code.stats.session.active", {
  description: "Number of active sessions (from stats cache)",
  unit: "1",
});

const sessionInfoGauge = meter.createObservableGauge("claude.code.stats.session.info", {
  description: "Active session information with metadata (from stats cache)",
  unit: "1",
});

const activeTimeCounter = meter.createCounter("claude.code.stats.active.time", {
  description: "Cumulative active time (from stats cache)",
  unit: "s",
});

const conversationCounter = meter.createCounter("claude.code.stats.conversation.count", {
  description: "Total count of Claude Code conversations (from project directories)",
  unit: "1",
});

// Track previous values to calculate deltas
let previousMetrics = {
  sessionCount: 0,
  messageCount: 0,
  toolCallCount: 0,
  tokensByModel: {},  // model -> {input, output, cacheRead, cacheWrite}
  costByModel: {},    // model -> USD
  conversationCount: 0,
  initialized: false,
};

// Track active sessions for info gauge
let activeSessions = []; // Array of {sessionId, title, project, modified}

// Track total conversations (all .jsonl files in projects dir)
let totalConversations = 0;

// Register callbacks for gauges only (counters are updated directly in updateMetrics)
meter.addBatchObservableCallback(
  (batchObservableResult) => {
    // Report active sessions count
    batchObservableResult.observe(activeSessionsGauge, currentMetrics.activeSessionCount, {
      source: INSTANCE_ID,
    });
    
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
  [activeSessionsGauge, sessionInfoGauge]
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

function scanConversations() {
  // Scan all .jsonl files in ~/.claude/projects/
  // Returns { total, newIds } where newIds are conversations we haven't seen before
  const projectsDir = join(CLAUDE_DATA_DIR, "projects");
  if (!existsSync(projectsDir)) return { total: 0, newIds: [] };
  
  const allIds = [];
  const newIds = [];
  
  try {
    const projects = readdirSync(projectsDir);
    for (const project of projects) {
      const projectPath = join(projectsDir, project);
      
      try {
        if (!statSync(projectPath).isDirectory()) continue;
        
        const files = readdirSync(projectPath);
        for (const file of files) {
          if (file.endsWith(".jsonl")) {
            const conversationId = `${project}/${file}`;
            allIds.push(conversationId);
            
            if (!seenConversationIds.has(conversationId)) {
              newIds.push(conversationId);
            }
          }
        }
      } catch (e) {
        // Skip directories we can't read
      }
    }
  } catch (error) {
    console.error(`Error scanning conversations: ${error.message}`);
  }
  
  return { total: allIds.length, newIds };
}

function getActiveSessions() {
  // Read sessions from project directories
  // Check actual file modification times (not just index timestamps)
  const projectsDir = join(CLAUDE_DATA_DIR, "projects");
  if (!existsSync(projectsDir)) return [];
  
  const activeWindowMs = ACTIVE_SESSION_HOURS * 60 * 60 * 1000;
  const cutoffTime = Date.now() - activeWindowMs;
  const sessions = [];
  
  try {
    const projects = readdirSync(projectsDir);
    for (const project of projects) {
      const projectPath = join(projectsDir, project);
      
      // Skip if not a directory
      try {
        if (!statSync(projectPath).isDirectory()) continue;
      } catch (e) {
        continue;
      }
      
      // Build session info from index if available
      const indexPath = join(projectPath, "sessions-index.json");
      let sessionIndex = {};
      
      if (existsSync(indexPath)) {
        try {
          const content = readFileSync(indexPath, "utf8");
          const index = JSON.parse(content);
          if (index.entries && Array.isArray(index.entries)) {
            for (const entry of index.entries) {
              sessionIndex[entry.sessionId] = entry;
            }
          }
        } catch (e) {
          // Index unreadable, continue without it
        }
      }
      
      // Scan for .jsonl files and check actual modification times
      try {
        const files = readdirSync(projectPath);
        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue;
          
          const filePath = join(projectPath, file);
          const sessionId = file.replace(".jsonl", "");
          
          try {
            const fileStat = statSync(filePath);
            const fileModifiedTime = fileStat.mtimeMs;
            
            if (fileModifiedTime > cutoffTime) {
              const indexEntry = sessionIndex[sessionId] || {};
              sessions.push({
                sessionId: sessionId,
                title: indexEntry.firstPrompt ? indexEntry.firstPrompt.slice(0, 100) : "",
                project: indexEntry.projectPath || project.replace(/-/g, "/").replace(/^\//, ""),
                modified: new Date(fileModifiedTime).toISOString(),
                messageCount: indexEntry.messageCount || 0,
              });
            }
          } catch (e) {
            // Skip files we can't stat
          }
        }
      } catch (e) {
        // Skip directories we can't read
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
  
  // Read current values from stats
  const newSessionCount = stats.totalSessions || 0;
  const newMessageCount = stats.totalMessages || 0;
  
  // Calculate total tool calls from daily activity
  let newToolCallCount = 0;
  if (stats.dailyActivity) {
    for (const day of stats.dailyActivity) {
      newToolCallCount += day.toolCallCount || 0;
    }
  }
  
  // Scan conversations - find new ones we haven't seen before
  const { total: totalConversationCount, newIds: newConversationIds } = scanConversations();
  
  // Build new token/cost maps
  const newTokensByModel = {};
  const newCostByModel = {};
  
  if (stats.modelUsage) {
    for (const [model, usage] of Object.entries(stats.modelUsage)) {
      newTokensByModel[model] = {
        input: usage.inputTokens || 0,
        output: usage.outputTokens || 0,
        cacheRead: usage.cacheReadInputTokens || 0,
        cacheWrite: usage.cacheCreationInputTokens || 0,
      };
      
      if (usage.costUSD > 0) {
        newCostByModel[model] = usage.costUSD;
      }
    }
  }
  
  // On first run, initialize counters with current totals (backfill)
  if (!previousMetrics.initialized) {
    console.log("Initializing counters with current totals (backfill)...");
    
    // Add initial totals to counters
    if (newSessionCount > 0) {
      sessionCounter.add(newSessionCount, { source: INSTANCE_ID });
    }
    if (newMessageCount > 0) {
      messageCounter.add(newMessageCount, { source: INSTANCE_ID });
    }
    if (newToolCallCount > 0) {
      toolCallCounter.add(newToolCallCount, { source: INSTANCE_ID });
    }
    
    // Add initial tokens
    for (const [model, tokens] of Object.entries(newTokensByModel)) {
      if (tokens.input > 0) {
        tokenCounter.add(tokens.input, { type: "input", model, source: INSTANCE_ID });
      }
      if (tokens.output > 0) {
        tokenCounter.add(tokens.output, { type: "output", model, source: INSTANCE_ID });
      }
      if (tokens.cacheRead > 0) {
        tokenCounter.add(tokens.cacheRead, { type: "cacheRead", model, source: INSTANCE_ID });
      }
      if (tokens.cacheWrite > 0) {
        tokenCounter.add(tokens.cacheWrite, { type: "cacheCreation", model, source: INSTANCE_ID });
      }
    }
    
    // Add initial costs
    for (const [model, cost] of Object.entries(newCostByModel)) {
      if (cost > 0) {
        costCounter.add(cost, { model, source: INSTANCE_ID });
      }
    }
    
    // Backfill active time counter with historical cumulative value
    if (cumulativeActiveTimeSeconds > 0) {
      activeTimeCounter.add(cumulativeActiveTimeSeconds, { source: INSTANCE_ID });
      previousActiveTimeSeconds = cumulativeActiveTimeSeconds;
      console.log(`Backfilled active time: ${cumulativeActiveTimeSeconds}s`);
    }
    
    // For conversations: DON'T backfill - just mark existing ones as seen
    // This ensures only NEW conversations (created after exporter starts) are counted
    // which makes Grafana time range filtering work correctly
    if (newConversationIds.length > 0) {
      for (const id of newConversationIds) {
        seenConversationIds.add(id);
      }
      saveSeenConversations();
      console.log(`Marked ${newConversationIds.length} existing conversations as seen (not backfilled)`);
    }
    console.log(`Total conversations on disk: ${totalConversationCount}`);
    
    // Store as previous
    previousMetrics = {
      sessionCount: newSessionCount,
      messageCount: newMessageCount,
      toolCallCount: newToolCallCount,
      tokensByModel: JSON.parse(JSON.stringify(newTokensByModel)),
      costByModel: JSON.parse(JSON.stringify(newCostByModel)),
      initialized: true,
    };
    
    const totalTokens = Object.values(newTokensByModel).reduce(
      (sum, t) => sum + t.input + t.output + t.cacheRead + t.cacheWrite, 0
    );
    console.log(`Backfilled: ${newSessionCount} sessions, ${newMessageCount} messages, ${totalTokens.toLocaleString()} tokens`);
  } else {
    // Calculate and add deltas
    let deltaTokens = 0;
    
    // Session delta
    const sessionDelta = newSessionCount - previousMetrics.sessionCount;
    if (sessionDelta > 0) {
      sessionCounter.add(sessionDelta, { source: INSTANCE_ID });
    }
    
    // Message delta
    const messageDelta = newMessageCount - previousMetrics.messageCount;
    if (messageDelta > 0) {
      messageCounter.add(messageDelta, { source: INSTANCE_ID });
    }
    
    // Tool call delta
    const toolCallDelta = newToolCallCount - previousMetrics.toolCallCount;
    if (toolCallDelta > 0) {
      toolCallCounter.add(toolCallDelta, { source: INSTANCE_ID });
    }
    
    // Token deltas by model
    for (const [model, tokens] of Object.entries(newTokensByModel)) {
      const prev = previousMetrics.tokensByModel[model] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      
      const inputDelta = tokens.input - prev.input;
      if (inputDelta > 0) {
        tokenCounter.add(inputDelta, { type: "input", model, source: INSTANCE_ID });
        deltaTokens += inputDelta;
      }
      
      const outputDelta = tokens.output - prev.output;
      if (outputDelta > 0) {
        tokenCounter.add(outputDelta, { type: "output", model, source: INSTANCE_ID });
        deltaTokens += outputDelta;
      }
      
      const cacheReadDelta = tokens.cacheRead - prev.cacheRead;
      if (cacheReadDelta > 0) {
        tokenCounter.add(cacheReadDelta, { type: "cacheRead", model, source: INSTANCE_ID });
        deltaTokens += cacheReadDelta;
      }
      
      const cacheWriteDelta = tokens.cacheWrite - prev.cacheWrite;
      if (cacheWriteDelta > 0) {
        tokenCounter.add(cacheWriteDelta, { type: "cacheCreation", model, source: INSTANCE_ID });
        deltaTokens += cacheWriteDelta;
      }
    }
    
    // Cost deltas by model
    for (const [model, cost] of Object.entries(newCostByModel)) {
      const prevCost = previousMetrics.costByModel[model] || 0;
      const costDelta = cost - prevCost;
      if (costDelta > 0) {
        costCounter.add(costDelta, { model, source: INSTANCE_ID });
      }
    }
    
    // New conversations (ones we haven't seen before)
    if (newConversationIds.length > 0) {
      conversationCounter.add(newConversationIds.length, { source: INSTANCE_ID });
      console.log(`New conversations: +${newConversationIds.length}`);
      
      // Mark them as seen
      for (const id of newConversationIds) {
        seenConversationIds.add(id);
      }
      saveSeenConversations();
    }
    
    // Update previous metrics
    previousMetrics = {
      sessionCount: newSessionCount,
      messageCount: newMessageCount,
      toolCallCount: newToolCallCount,
      tokensByModel: JSON.parse(JSON.stringify(newTokensByModel)),
      costByModel: JSON.parse(JSON.stringify(newCostByModel)),
      initialized: true,
    };
    
    if (deltaTokens > 0) {
      console.log(`Delta: +${deltaTokens.toLocaleString()} tokens`);
    }
  }
  
  // Update current metrics for gauges
  currentMetrics.sessionCount = newSessionCount;
  currentMetrics.messageCount = newMessageCount;
  currentMetrics.toolCallCount = newToolCallCount;
  currentMetrics.tokensByModel = newTokensByModel;
  currentMetrics.costByModel = newCostByModel;
  
  // Get active sessions (modified within last N hours)
  activeSessions = getActiveSessions();
  currentMetrics.activeSessionCount = activeSessions.length;
  
  // Update cumulative active time tracking
  const prevActiveTime = cumulativeActiveTimeSeconds;
  updateActiveTime(activeSessions.length > 0);
  
  // Add delta to counter (counter needs deltas, not absolute values)
  const activeTimeDelta = cumulativeActiveTimeSeconds - previousActiveTimeSeconds;
  if (activeTimeDelta > 0) {
    activeTimeCounter.add(activeTimeDelta, { source: INSTANCE_ID });
    previousActiveTimeSeconds = cumulativeActiveTimeSeconds;
  }
  
  // Log summary
  const totalTokens = Object.values(currentMetrics.tokensByModel).reduce(
    (sum, t) => sum + t.input + t.output + t.cacheRead + t.cacheWrite, 0
  );
  
  const activeTimeHrs = (cumulativeActiveTimeSeconds / 3600).toFixed(1);
  console.log(`Updated: ${totalConversationCount} convos (${seenConversationIds.size} tracked), ${currentMetrics.sessionCount} sessions, ${currentMetrics.messageCount} msgs, ${totalTokens.toLocaleString()} tokens, ${currentMetrics.activeSessionCount} active`);
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
loadActiveTimeState();
loadSeenConversations();
updateMetrics();

// Poll for updates
setInterval(updateMetrics, POLL_INTERVAL);
console.log(`Polling every ${POLL_INTERVAL}ms`);
