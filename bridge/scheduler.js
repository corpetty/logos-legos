/**
 * Scheduler - Lightweight cron/interval scheduler for deployed workflows.
 *
 * Manages timer-based triggers for deployed workflows. When a workflow with
 * a timer trigger is deployed, the scheduler starts firing it on schedule.
 *
 * Supports two modes:
 *   - interval: fires every N milliseconds (uses setInterval directly)
 *   - cron: fires when current time matches a 5-field cron expression
 *           (checked every 60 seconds via a shared cron ticker)
 *
 * No external dependencies — uses a simple built-in cron parser.
 */

// ── Cron Parser ──────────────────────────────────────────────────────────

/**
 * Parse a 5-field cron expression into a match object.
 * Fields: minute hour day-of-month month day-of-week
 *
 * Supports:
 *   *        — any value
 *   N        — exact value
 *   N-M      — range (inclusive)
 *   N,M,O    — list
 *   * /N     — step (every Nth value, written without space)
 *   N-M/S    — range with step
 *
 * Day-of-week: 0 = Sunday, 6 = Saturday (also 7 = Sunday)
 *
 * @param {string} expr - Cron expression (e.g., "0 9 * * 1-5")
 * @returns {{ minute: Set, hour: Set, dom: Set, month: Set, dow: Set }}
 */
function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
  }

  const ranges = {
    minute: { min: 0, max: 59 },
    hour:   { min: 0, max: 23 },
    dom:    { min: 1, max: 31 },
    month:  { min: 1, max: 12 },
    dow:    { min: 0, max: 6 },
  };

  const fieldNames = ["minute", "hour", "dom", "month", "dow"];
  const result = {};

  for (let i = 0; i < 5; i++) {
    const field = parts[i];
    const { min, max } = ranges[fieldNames[i]];
    result[fieldNames[i]] = parseField(field, min, max);
  }

  return result;
}

/**
 * Parse a single cron field into a Set of valid values.
 */
function parseField(field, min, max) {
  const values = new Set();

  // Handle comma-separated list
  const segments = field.split(",");
  for (const segment of segments) {
    // Check for step: "*/2", "1-5/2", etc.
    const stepParts = segment.split("/");
    const range = stepParts[0];
    const step = stepParts[1] ? parseInt(stepParts[1], 10) : 1;

    if (isNaN(step) || step < 1) {
      throw new Error(`Invalid step value in cron field: ${segment}`);
    }

    let start, end;

    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number);
      if (isNaN(lo) || isNaN(hi)) {
        throw new Error(`Invalid range in cron field: ${segment}`);
      }
      start = lo;
      end = hi;
    } else {
      const val = parseInt(range, 10);
      if (isNaN(val)) {
        throw new Error(`Invalid value in cron field: ${segment}`);
      }
      if (step === 1) {
        values.add(val);
        continue;
      }
      start = val;
      end = max;
    }

    for (let v = start; v <= end; v += step) {
      values.add(v);
    }
  }

  return values;
}

/**
 * Check if a Date matches a parsed cron expression.
 */
function cronMatches(parsed, date) {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-based
  let dow = date.getDay(); // 0 = Sunday

  return parsed.minute.has(minute) &&
         parsed.hour.has(hour) &&
         parsed.dom.has(dom) &&
         parsed.month.has(month) &&
         parsed.dow.has(dow);
}

// ── Scheduler Class ──────────────────────────────────────────────────────

class Scheduler {
  /**
   * @param {WorkflowEngine} engine - The workflow engine to execute workflows on
   */
  constructor(engine) {
    this.engine = engine;
    this.timers = new Map();  // workflowId → { type, handle, config, parsedCron? }
    this._cronTick = null;    // 60-second interval for cron checking
    this._lastCronMinute = -1; // Prevent double-firing in the same minute
  }

  /**
   * Schedule a workflow's timer trigger.
   * @param {string} workflowId
   * @param {object} triggerConfig - { mode, intervalMs, cron }
   */
  schedule(workflowId, triggerConfig) {
    // Remove existing schedule for this workflow
    this.unschedule(workflowId);

    const mode = triggerConfig.mode || "interval";

    if (mode === "interval") {
      const intervalMs = triggerConfig.intervalMs || 60000;
      const handle = setInterval(() => {
        this._fire(workflowId);
      }, intervalMs);

      this.timers.set(workflowId, {
        type: "interval",
        handle,
        config: { intervalMs },
        scheduledAt: new Date().toISOString(),
      });

      console.log(`[scheduler] Scheduled '${workflowId}' interval every ${intervalMs}ms`);

    } else if (mode === "cron") {
      const cronExpr = triggerConfig.cron || "* * * * *";
      let parsedCron;
      try {
        parsedCron = parseCron(cronExpr);
      } catch (e) {
        console.error(`[scheduler] Invalid cron for '${workflowId}': ${e.message}`);
        return;
      }

      this.timers.set(workflowId, {
        type: "cron",
        handle: null, // Uses shared cron ticker
        config: { cron: cronExpr },
        parsedCron,
        scheduledAt: new Date().toISOString(),
      });

      // Start the shared cron ticker if not running
      this._ensureCronTicker();

      console.log(`[scheduler] Scheduled '${workflowId}' cron: ${cronExpr}`);
    }
  }

  /**
   * Unschedule a workflow's timer.
   */
  unschedule(workflowId) {
    const timer = this.timers.get(workflowId);
    if (!timer) return;

    if (timer.type === "interval" && timer.handle) {
      clearInterval(timer.handle);
    }

    this.timers.delete(workflowId);
    console.log(`[scheduler] Unscheduled '${workflowId}'`);

    // Stop cron ticker if no more cron schedules
    if (this._cronTick) {
      const hasCron = [...this.timers.values()].some(t => t.type === "cron");
      if (!hasCron) {
        clearInterval(this._cronTick);
        this._cronTick = null;
      }
    }
  }

  /**
   * Get status of all active schedules.
   */
  getStatus() {
    const schedules = [];
    for (const [workflowId, timer] of this.timers) {
      const entry = {
        workflowId,
        type: timer.type,
        config: timer.config,
        scheduledAt: timer.scheduledAt,
      };

      if (timer.type === "cron") {
        entry.nextFire = this._nextCronFire(timer.parsedCron);
      } else if (timer.type === "interval") {
        entry.intervalMs = timer.config.intervalMs;
      }

      schedules.push(entry);
    }
    return schedules;
  }

  /**
   * Stop all timers (for graceful shutdown).
   */
  stopAll() {
    for (const [workflowId] of this.timers) {
      this.unschedule(workflowId);
    }
    if (this._cronTick) {
      clearInterval(this._cronTick);
      this._cronTick = null;
    }
  }

  /**
   * Fire a workflow execution via the engine.
   */
  async _fire(workflowId) {
    console.log(`[scheduler] Firing timer for '${workflowId}'`);
    try {
      const result = await this.engine.execute(workflowId, "timer", {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
        source: "scheduler",
      });
      if (result.success) {
        console.log(`[scheduler] '${workflowId}' completed (${result.steps} steps)`);
      } else {
        console.error(`[scheduler] '${workflowId}' failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`[scheduler] '${workflowId}' error: ${e.message}`);
    }
  }

  /**
   * Start the shared 60-second cron ticker.
   */
  _ensureCronTicker() {
    if (this._cronTick) return;

    this._cronTick = setInterval(() => {
      this._checkCronMatches();
    }, 60000); // Check every 60 seconds

    // Also check immediately (in case we're at the start of a minute)
    setTimeout(() => this._checkCronMatches(), 1000);
  }

  /**
   * Check all cron-scheduled workflows and fire any that match now.
   */
  _checkCronMatches() {
    const now = new Date();
    const currentMinute = now.getHours() * 60 + now.getMinutes();

    // Prevent double-firing in the same minute
    if (currentMinute === this._lastCronMinute) return;
    this._lastCronMinute = currentMinute;

    for (const [workflowId, timer] of this.timers) {
      if (timer.type !== "cron" || !timer.parsedCron) continue;

      if (cronMatches(timer.parsedCron, now)) {
        this._fire(workflowId);
      }
    }
  }

  /**
   * Estimate next cron fire time (approximate, for status display).
   */
  _nextCronFire(parsedCron) {
    const now = new Date();
    // Check up to 48 hours ahead in 1-minute increments
    for (let m = 1; m <= 2880; m++) {
      const candidate = new Date(now.getTime() + m * 60000);
      if (cronMatches(parsedCron, candidate)) {
        return candidate.toISOString();
      }
    }
    return null;
  }
}

module.exports = { Scheduler, parseCron, cronMatches };
