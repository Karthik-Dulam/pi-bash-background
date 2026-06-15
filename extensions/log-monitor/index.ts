/**
 * Log Monitor Extension
 *
 * Tools the agent can use to watch a log file and run an analysis script
 * whenever trigger words appear or on a periodic interval.
 * Script output is queued as a steer message so the agent is interrupted
 * with the findings.
 *
 * Tools:
 *   start_log_monitor(id, log_file, period_seconds, trigger_words, script)
 *   stop_log_monitor(id)
 *   list_log_monitors()
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RECENT_LINES = 300;
const SCRIPT_TIMEOUT_MS = 30_000;
const READ_CHUNK_MAX = 256_000; // max bytes to read per change event

// ─── Types ────────────────────────────────────────────────────────────────────

interface Monitor {
    id: string;
    logFile: string;
    periodSeconds: number;
    triggerWords: string[];
    script: string;
    scriptPath: string;
    // tracking
    lastSize: number;
    lastTriggeredAt: number; // epoch ms, 0 = never
    lastReason: string;
    triggerCount: number;
    recentLines: string[];
    // handles
    watcher: FSWatcher | null;
    timer: ReturnType<typeof setInterval> | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtAge(ts: number): string {
    if (!ts) return "never";
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
}

function readNewBytes(mon: Monitor): string {
    try {
        const size = statSync(mon.logFile).size;

        // File truncated — reset and skip
        if (size < mon.lastSize) {
            mon.lastSize = size;
            mon.recentLines = [];
            return "";
        }

        if (size === mon.lastSize) return "";

        const toRead = Math.min(size - mon.lastSize, READ_CHUNK_MAX);
        const offset = size - toRead;
        const fd = openSync(mon.logFile, "r");
        try {
            const buf = Buffer.alloc(toRead);
            readSync(fd, buf, 0, toRead, offset);
            mon.lastSize = size;
            const text = buf.toString("utf8");
            const newLines = text.split("\n");
            mon.recentLines.push(...newLines);
            if (mon.recentLines.length > MAX_RECENT_LINES) {
                mon.recentLines = mon.recentLines.slice(-MAX_RECENT_LINES);
            }
            return text;
        } finally {
            closeSync(fd);
        }
    } catch {
        return "";
    }
}

function matchesTrigger(text: string, words: string[]): string | null {
    for (const w of words) {
        try {
            if (new RegExp(w, "i").test(text)) return w;
        } catch {
            if (text.toLowerCase().includes(w.toLowerCase())) return w;
        }
    }
    return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function logMonitorExtension(pi: ExtensionAPI): void {
    const monitors = new Map<string, Monitor>();
    let storedCtx: ExtensionContext | null = null;

    // ── Widget / status ────────────────────────────────────────────────────────

    function updateUI(): void {
        if (!storedCtx) return;
        const ctx = storedCtx;
        const theme = ctx.ui.theme;

        if (monitors.size === 0) {
            ctx.ui.setWidget("log-monitor", undefined);
            ctx.ui.setStatus("log-monitor", undefined);
            return;
        }

        // Footer
        const statusLabel =
            monitors.size === 1
                ? theme.fg("accent", `● monitor:${[...monitors.keys()][0]}`)
                : theme.fg("accent", `● ${monitors.size} monitors`);
        ctx.ui.setStatus("log-monitor", statusLabel);

        // Widget — one row per monitor
        ctx.ui.setWidget("log-monitor", (_tui, theme) => {
            const rows = [...monitors.values()].map((m) => {
                const dot = theme.fg("accent", "●");
                const id = theme.bold(m.id);
                const file = theme.fg("muted", basename(m.logFile));
                const triggers =
                    m.triggerWords.length > 0
                        ? theme.fg("warning", m.triggerWords.join("│"))
                        : theme.fg("dim", "no triggers");
                const period =
                    m.periodSeconds > 0
                        ? theme.fg("dim", `every ${m.periodSeconds}s`)
                        : theme.fg("dim", "event-only");
                const fires = theme.fg(
                    m.triggerCount > 0 ? "success" : "dim",
                    `✦ ${m.triggerCount}`
                );
                const last = theme.fg("dim", fmtAge(m.lastTriggeredAt));
                return `  ${dot} ${id}  ${file}  [${triggers}]  ${period}  ${fires}  ${last}`;
            });

            return {
                render: (width) => rows.map((r) => truncateToWidth(r, width)),
                invalidate: () => {},
            };
        });
    }

    // ── Script runner ──────────────────────────────────────────────────────────

    function runScript(mon: Monitor, reason: string): void {
        const content = mon.recentLines.join("\n");
        const proc = spawn("sh", ["-c", mon.script], {
            stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

        const timer = setTimeout(() => proc.kill("SIGTERM"), SCRIPT_TIMEOUT_MS);

        proc.stdin.write(content);
        proc.stdin.end();

        proc.on("close", (code) => {
            clearTimeout(timer);
            const output = stdout.trim() || stderr.trim() || "(no output)";
            const exitNote = code !== 0 ? `\n[script exit ${code}]` : "";

            pi.sendMessage(
                {
                    customType: "log-monitor-alert",
                    display: true,
                    content:
                        `[Log Monitor: ${mon.id}] ${reason}\n` +
                        `File: ${mon.logFile}\n\n` +
                        `--- Script output ---\n${output}${exitNote}`,
                    details: { monitorId: mon.id, reason, logFile: mon.logFile },
                },
                { deliverAs: "steer", triggerTurn: true }
            );

            mon.lastTriggeredAt = Date.now();
            mon.lastReason = reason;
            mon.triggerCount++;
            updateUI();
        });

        proc.on("error", (err) => {
            pi.sendMessage(
                {
                    customType: "log-monitor-alert",
                    display: true,
                    content: `[Log Monitor: ${mon.id}] Script error: ${err.message}`,
                    details: { monitorId: mon.id, error: err.message },
                },
                { deliverAs: "steer", triggerTurn: true }
            );
        });
    }

    // ── Monitor lifecycle ──────────────────────────────────────────────────────

    function startMonitor(mon: Monitor): void {
        // Seed recent lines from existing file tail
        try {
            const raw = readFileSync(mon.logFile, "utf8");
            const lines = raw.split("\n");
            mon.recentLines = lines.slice(-MAX_RECENT_LINES);
            mon.lastSize = statSync(mon.logFile).size;
        } catch {
            mon.lastSize = 0;
        }

        // Real-time file watcher for trigger words
        try {
            mon.watcher = watch(mon.logFile, () => {
                const newText = readNewBytes(mon);
                if (!newText) return;
                const hit = matchesTrigger(newText, mon.triggerWords);
                if (hit) {
                    runScript(mon, `trigger word matched: "${hit}"`);
                }
            });
        } catch {
            // File may not be watchable on all platforms; periodic still works
        }

        // Periodic analysis
        if (mon.periodSeconds > 0) {
            mon.timer = setInterval(() => {
                readNewBytes(mon); // keep buffer fresh even if no trigger
                runScript(mon, `periodic (every ${mon.periodSeconds}s)`);
            }, mon.periodSeconds * 1000);
            mon.timer.unref();
        }
    }

    function stopMonitor(id: string): boolean {
        const mon = monitors.get(id);
        if (!mon) return false;
        mon.watcher?.close();
        if (mon.timer) clearInterval(mon.timer);
        monitors.delete(id);
        updateUI();
        return true;
    }

    // ── Session hooks ──────────────────────────────────────────────────────────

    pi.on("session_start", async (_event, ctx) => {
        storedCtx = ctx;
        updateUI();
    });

    pi.on("session_shutdown", async () => {
        for (const id of [...monitors.keys()]) stopMonitor(id);
        storedCtx = null;
    });

    // ── Tools ──────────────────────────────────────────────────────────────────

    pi.registerTool({
        name: "start_log_monitor",
        label: "Start Log Monitor",
        description:
            "Watch a log file and run an analysis script whenever trigger words appear " +
            "or on a periodic interval. Script receives recent log lines on stdin and its " +
            "stdout is queued as a steer message to the agent.",
        promptSnippet:
            "Watch a log file for trigger words or periodically; runs a script and steers the agent with findings",
        parameters: Type.Object({
            id: Type.String({
                description: "Unique monitor ID (used to stop it later, e.g. 'myapp')",
            }),
            log_file: Type.String({
                description: "Absolute path to the log file to watch",
            }),
            period_seconds: Type.Number({
                description:
                    "Run the analysis script every N seconds regardless of trigger words. " +
                    "Set to 0 to disable periodic runs (event-only mode).",
                minimum: 0,
            }),
            trigger_words: Type.Array(Type.String(), {
                description:
                    "Words or regex patterns (case-insensitive) that trigger immediate analysis " +
                    "when they appear in new log lines. Empty array = no trigger-word detection.",
            }),
            script: Type.String({
                description:
                    "Shell script to analyze the logs. Recent log lines are piped to stdin. " +
                    "Write a concise summary to stdout — it becomes the steer message. " +
                    "Example: 'tail -5 | grep -i error'",
            }),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            storedCtx = ctx;

            // Replace existing monitor with same id
            if (monitors.has(params.id)) stopMonitor(params.id);

            if (!existsSync(params.log_file)) {
                return {
                    content: [{ type: "text", text: `Error: file not found: ${params.log_file}` }],
                    isError: true,
                    details: {},
                };
            }

            // Save script to disk
            const monitorsDir = join(homedir(), ".pi", "agent", "bash-background", "monitors");
            mkdirSync(monitorsDir, { recursive: true });
            const scriptPath = join(monitorsDir, `${params.id}.sh`);
            writeFileSync(scriptPath, params.script, { mode: 0o755 });

            const mon: Monitor = {
                id: params.id,
                logFile: params.log_file,
                periodSeconds: params.period_seconds,
                triggerWords: params.trigger_words,
                script: params.script,
                scriptPath,
                lastSize: 0,
                lastTriggeredAt: 0,
                lastReason: "",
                triggerCount: 0,
                recentLines: [],
                watcher: null,
                timer: null,
            };

            monitors.set(params.id, mon);
            startMonitor(mon);
            updateUI();

            const triggerDesc =
                params.trigger_words.length > 0
                    ? `trigger words: ${params.trigger_words.join(", ")}`
                    : "no trigger words";
            const periodDesc =
                params.period_seconds > 0
                    ? `every ${params.period_seconds}s`
                    : "event-only";

            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Monitor "${params.id}" started.\n` +
                            `File: ${params.log_file}\n` +
                            `${triggerDesc} | ${periodDesc}`,
                    },
                ],
                details: {
                    id: params.id,
                    logFile: params.log_file,
                    scriptPath,
                    periodSeconds: params.period_seconds,
                    triggerWords: params.trigger_words,
                },
            };
        },

        renderCall(args, theme) {
            const id = theme.fg("accent", args.id ?? "?");
            const file = theme.fg("muted", args.log_file ? basename(args.log_file) : "?");
            const triggers =
                args.trigger_words?.length > 0
                    ? theme.fg("warning", args.trigger_words.join("│"))
                    : theme.fg("dim", "no triggers");
            const period =
                args.period_seconds > 0
                    ? theme.fg("dim", `every ${args.period_seconds}s`)
                    : theme.fg("dim", "event-only");
            const header = `${theme.bold("start_log_monitor")}  ${id}  ${file}  [${triggers}]  ${period}`;
            const scriptFile = args.id ? theme.fg("dim", `  → ~/.pi/agent/bash-background/monitors/${args.id}.sh`) : "";
            const script = (args.script ?? "")
                .split("\n")
                .map((l: string) => `  ${theme.fg("dim", "│")} ${theme.fg("syntaxString", l)}`)
                .join("\n");
            return new Text(`${header}${scriptFile}\n${script}`, 0, 0);
        },

        renderResult(result, _opts, theme) {
            if (result.isError) {
                const msg = result.content[0];
                return new Text(
                    theme.fg("error", msg?.type === "text" ? msg.text : "Error"),
                    0, 0
                );
            }
            const d = result.details as { id?: string; logFile?: string; scriptPath?: string } | undefined;
            return new Text(
                theme.fg("success", "✓ ") +
                    theme.fg("text", `Watching `) +
                    theme.fg("muted", d?.logFile ? basename(d.logFile) : "?") +
                    theme.fg("dim", `  [${d?.id ?? "?"}]`) +
                    (d?.scriptPath ? `\n  ${theme.fg("dim", d.scriptPath)}` : ""),
                0, 0
            );
        },
    });

    pi.registerTool({
        name: "stop_log_monitor",
        label: "Stop Log Monitor",
        description: "Stop a running log monitor by its ID.",
        parameters: Type.Object({
            id: Type.String({ description: "Monitor ID to stop" }),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            storedCtx = ctx;
            const stopped = stopMonitor(params.id);
            return {
                content: [
                    {
                        type: "text",
                        text: stopped
                            ? `Monitor "${params.id}" stopped.`
                            : `No monitor found with id "${params.id}".`,
                    },
                ],
                details: { id: params.id, stopped },
            };
        },

        renderCall(args, theme) {
            return new Text(
                `${theme.bold("stop_log_monitor")}  ${theme.fg("accent", args.id ?? "?")}`,
                0, 0
            );
        },

        renderResult(result, _opts, theme) {
            const d = result.details as { stopped?: boolean; id?: string } | undefined;
            return new Text(
                d?.stopped
                    ? theme.fg("success", "✓ ") + theme.fg("muted", `Stopped ${d?.id}`)
                    : theme.fg("warning", `⚠ No monitor: ${d?.id}`),
                0, 0
            );
        },
    });

    pi.registerTool({
        name: "list_log_monitors",
        label: "List Log Monitors",
        description: "List all active log monitors and their status.",
        parameters: Type.Object({}),

        async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
            storedCtx = ctx;
            if (monitors.size === 0) {
                return {
                    content: [{ type: "text", text: "No active monitors." }],
                    details: { monitors: [] },
                };
            }
            const rows = [...monitors.values()].map((m) => ({
                id: m.id,
                logFile: m.logFile,
                periodSeconds: m.periodSeconds,
                triggerWords: m.triggerWords,
                triggerCount: m.triggerCount,
                lastTriggeredAt: m.lastTriggeredAt,
                lastReason: m.lastReason,
            }));
            const lines = rows.map(
                (r) =>
                    `• ${r.id}  ${r.logFile}  ` +
                    `triggers:[${r.triggerWords.join(",")}]  ` +
                    `period:${r.periodSeconds}s  ` +
                    `fires:${r.triggerCount}  ` +
                    `last:${fmtAge(r.lastTriggeredAt)}`
            );
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: { monitors: rows },
            };
        },

        renderCall(_args, theme) {
            return new Text(theme.bold("list_log_monitors"), 0, 0);
        },

        renderResult(result, _opts, theme) {
            const d = result.details as { monitors?: { id: string; triggerCount: number; logFile: string }[] } | undefined;
            const rows = d?.monitors ?? [];
            if (rows.length === 0) {
                return new Text(theme.fg("dim", "No active monitors"), 0, 0);
            }
            const lines = rows
                .map(
                    (r) =>
                        theme.fg("accent", "● ") +
                        theme.bold(r.id) +
                        theme.fg("dim", `  ${basename(r.logFile)}`) +
                        theme.fg(r.triggerCount > 0 ? "success" : "dim", `  ✦ ${r.triggerCount}`)
                )
                .join("\n");
            return new Text(lines, 0, 0);
        },
    });
}
