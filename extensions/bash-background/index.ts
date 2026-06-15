import { spawn, type ChildProcess } from "node:child_process";
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readSync,
    statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

const OUTPUT_TAIL_CHARS = 50_000;
const UPDATE_TAIL_CHARS = 12_000;
const UPDATE_INTERVAL_MS = 500;

type JobStatus = "running" | "completed" | "failed" | "killed";

interface BashParams {
    command: string;
    timeout?: number;
}

interface BackgroundJob {
    id: string;
    command: string;
    cwd: string;
    pid: number;
    logPath: string;
    startTime: number;
    backgroundedAt?: number;
    endTime?: number;
    exitCode?: number | null;
    status: JobStatus;
    proc?: ChildProcess;
}

type JobDetails = Omit<BackgroundJob, "proc">;

interface ActiveBashRun {
    toolCallId: string;
    command: string;
    proc: ChildProcess;
    job: BackgroundJob;
    background: (stopAgent: boolean) => void;
}

const bashParams = Type.Object({
    command: Type.String({ description: "Shell command to execute" }),
    timeout: Type.Optional(
        Type.Number({
            description:
                "Optional timeout in seconds while the command is in the foreground",
            minimum: 1,
        })
    ),
});

function jobsDir(): string {
    return join(homedir(), ".pi", "agent", "bash-background");
}

function makeJobId(counter: number): string {
    return `bg-${counter}-${process.pid}`;
}

function makeLogPath(jobId: string): string {
    return join(jobsDir(), `${jobId}.log`);
}

function readTail(path: string, maxBytes: number): string {
    if (!existsSync(path)) return "";

    const size = statSync(path).size;
    if (size === 0) return "";

    const length = Math.min(size, maxBytes);
    const start = size - length;
    const fd = openSync(path, "r");
    try {
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, start);
        const prefix = start > 0 ? `[output truncated to last ${length} bytes]\n` : "";
        return prefix + buffer.toString("utf8");
    } finally {
        closeSync(fd);
    }
}

function formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return `${seconds}s`;
    return `${minutes}m ${seconds}s`;
}

function commandPreview(command: string): string {
    const oneLine = command.replace(/\s+/g, " ").trim();
    return oneLine.length > 70 ? `${oneLine.slice(0, 67)}…` : oneLine;
}

function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            // Process already exited.
        }
    }
}

function renderJob(job: BackgroundJob): string {
    const elapsed = formatDuration((job.endTime ?? Date.now()) - job.startTime);
    const exit = job.exitCode === undefined ? "" : ` exit=${job.exitCode}`;
    return `${job.id} [${job.status}${exit}] ${elapsed} pid=${job.pid} ${commandPreview(job.command)}\n  log: ${job.logPath}`;
}

function jobDetails(job: BackgroundJob): JobDetails {
    return {
        id: job.id,
        command: job.command,
        cwd: job.cwd,
        pid: job.pid,
        logPath: job.logPath,
        startTime: job.startTime,
        backgroundedAt: job.backgroundedAt,
        endTime: job.endTime,
        exitCode: job.exitCode,
        status: job.status,
    };
}

function updateStatus(
    ctx: ExtensionContext,
    activeRun: ActiveBashRun | undefined,
    jobs: Map<string, BackgroundJob>
): void {
    const runningJobs = [...jobs.values()].filter(
        (job) => job.status === "running"
    ).length;

    if (activeRun) {
        ctx.ui.setStatus(
            "bash-bg",
            ctx.ui.theme.fg("warning", "⏱ ctrl+b continue · ctrl+shift+b wait")
        );
        return;
    }

    if (runningJobs > 0) {
        ctx.ui.setStatus(
            "bash-bg",
            ctx.ui.theme.fg(
                "accent",
                `◐ ${runningJobs} bg job${runningJobs === 1 ? "" : "s"}`
            )
        );
        return;
    }

    ctx.ui.setStatus("bash-bg", undefined);
}

export default function bashBackgroundExtension(pi: ExtensionAPI): void {
    let jobCounter = 0;
    let activeRun: ActiveBashRun | undefined;
    const jobs = new Map<string, BackgroundJob>();

    function latestJob(): BackgroundJob | undefined {
        return [...jobs.values()].sort((a, b) => b.startTime - a.startTime)[0];
    }

    pi.registerTool({
        name: "bash",
        label: "bash (ctrl+b backgroundable)",
        description:
            "Execute a shell command. While it is running in the foreground, press Ctrl+B to detach it and keep working, or Ctrl+Shift+B to detach it and wait for the completion notification. Backgrounded output is written to a log file.",
        promptSnippet:
            "Run shell commands; user can press Ctrl+B to background and continue, or Ctrl+Shift+B to background and wait",
        promptGuidelines: [
            "Use bash for shell commands. If a command is backgrounded with Ctrl+B, continue if useful. If it is backgrounded with Ctrl+Shift+B, end the current turn because the user wants to wait for the completion notification."
        ],
        parameters: bashParams,
        executionMode: "sequential",

        async execute(
            toolCallId,
            params: BashParams,
            signal,
            onUpdate,
            ctx
        ): Promise<AgentToolResult<JobDetails>> {
            mkdirSync(jobsDir(), { recursive: true });

            const jobId = makeJobId(++jobCounter);
            const logPath = makeLogPath(jobId);
            mkdirSync(dirname(logPath), { recursive: true });

            const logFd = openSync(logPath, "w");
            const proc = spawn("bash", ["-lc", params.command], {
                cwd: ctx.cwd,
                detached: true,
                env: { ...process.env },
                stdio: ["ignore", logFd, logFd],
            });
            closeSync(logFd);

            if (!proc.pid) {
                throw new Error("Failed to start bash process");
            }
            const pid = proc.pid;

            const job: BackgroundJob = {
                id: jobId,
                command: params.command,
                cwd: ctx.cwd,
                pid,
                logPath,
                startTime: Date.now(),
                status: "running",
                proc,
            };
            jobs.set(jobId, job);

            let didBackground = false;
            let didTimeout = false;
            let stopAgentAfterBackground = false;
            let backgroundResolve: (() => void) | undefined;

            const backgrounded = new Promise<"backgrounded">((resolve) => {
                backgroundResolve = () => resolve("backgrounded");
            });
            const exited = new Promise<"exited">((resolve) => {
                proc.once("close", (code) => {
                    job.endTime = Date.now();
                    job.exitCode = code;
                    if (job.status === "killed") {
                        // Keep killed status.
                    } else if (code === 0) {
                        job.status = "completed";
                    } else {
                        job.status = "failed";
                    }

                    if (didBackground) {
                        const output = readTail(job.logPath, UPDATE_TAIL_CHARS) || "(no output)";
                        const statusLine =
                            code === 0
                                ? `Background job ${job.id} ${job.status}.`
                                : `Background job ${job.id} ${job.status} (exit ${code ?? "signal"}).`;
                        ctx.ui.notify(statusLine, code === 0 ? "info" : "warning");
                        pi.sendMessage(
                            {
                                customType: "bash-background-complete",
                                display: true,
                                content:
                                    `The backgrounded bash command has finished. Continue from this result.\n\n` +
                                    `${statusLine}\n` +
                                    `Command: ${job.command}\n` +
                                    `Log: ${job.logPath}\n\n` +
                                    `--- OUTPUT ---\n${output}`,
                                details: jobDetails(job),
                            },
                            { deliverAs: "steer", triggerTurn: true }
                        );
                        updateStatus(ctx, undefined, jobs);
                    }
                    resolve("exited");
                });
            });

            const abortHandler = (): void => {
                if (didBackground) return;
                job.status = "killed";
                killProcessGroup(pid, "SIGTERM");
            };
            signal?.addEventListener("abort", abortHandler, { once: true });

            let timeout: NodeJS.Timeout | undefined;
            if (params.timeout !== undefined) {
                timeout = setTimeout(() => {
                    if (didBackground) return;
                    didTimeout = true;
                    job.status = "killed";
                    killProcessGroup(pid, "SIGTERM");
                }, params.timeout * 1000);
                timeout.unref();
            }

            const updateTimer = setInterval(() => {
                onUpdate?.({
                    content: [
                        {
                            type: "text",
                            text: readTail(logPath, UPDATE_TAIL_CHARS) || "(no output yet)",
                        },
                    ],
                    details: jobDetails(job),
                });
            }, UPDATE_INTERVAL_MS);
            updateTimer.unref();

            activeRun = {
                toolCallId,
                command: params.command,
                proc,
                job,
                background: (stopAgent: boolean) => {
                    if (didBackground) return;
                    didBackground = true;
                    job.backgroundedAt = Date.now();
                    stopAgentAfterBackground = stopAgent;
                    proc.unref();
                    backgroundResolve?.();
                },
            };
            updateStatus(ctx, activeRun, jobs);

            const outcome = await Promise.race([exited, backgrounded]);

            signal?.removeEventListener("abort", abortHandler);
            if (timeout) clearTimeout(timeout);
            clearInterval(updateTimer);
            if (activeRun?.toolCallId === toolCallId) activeRun = undefined;
            updateStatus(ctx, activeRun, jobs);

            const outputTail = readTail(logPath, OUTPUT_TAIL_CHARS);

            if (outcome === "backgrounded") {
                const ranBeforeBackground = formatDuration(
                    (job.backgroundedAt ?? Date.now()) - job.startTime
                );
                ctx.ui.notify(`Backgrounded ${job.id}. Log: ${logPath}`, "info");
                const instruction = `User backgrounded the command after ${ranBeforeBackground}. You will be notified when it is done.`;
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                `${instruction}\n\n` +
                                `Backgrounded bash command as ${job.id}.\n` +
                                `PID: ${job.pid}\n` +
                                `Log: ${job.logPath}\n\n` +
                                `Current output tail:\n${outputTail || "(no output yet)"}`,
                        },
                    ],
                    details: jobDetails(job),
                    terminate: stopAgentAfterBackground ? true : undefined,
                };
            }

            const timedOutText = didTimeout
                ? `\nCommand timed out after ${params.timeout}s and was terminated.\n`
                : "";
            const exitText = job.exitCode === 0 ? "" : `\n[exit code: ${job.exitCode ?? "signal"}]`;
            return {
                content: [
                    {
                        type: "text",
                        text: (outputTail || "(no output)") + timedOutText + exitText,
                    },
                ],
                details: jobDetails(job),
            };
        },
    });

    pi.registerShortcut("ctrl+b", {
        description: "Background the currently running bash command",
        handler: async (ctx) => {
            if (!activeRun) {
                ctx.ui.notify("No foreground bash command is running.", "info");
                updateStatus(ctx, activeRun, jobs);
                return;
            }
            activeRun.background(false);
            updateStatus(ctx, undefined, jobs);
        },
    });

    pi.registerShortcut("ctrl+shift+b", {
        description: "Background the currently running bash command and wait for completion",
        handler: async (ctx) => {
            if (!activeRun) {
                ctx.ui.notify("No foreground bash command is running.", "info");
                updateStatus(ctx, activeRun, jobs);
                return;
            }
            activeRun.background(true);
            updateStatus(ctx, undefined, jobs);
        },
    });

    pi.registerCommand("bg-jobs", {
        description: "List bash commands backgrounded with Ctrl+B",
        handler: async (_args, ctx) => {
            if (jobs.size === 0) {
                ctx.ui.notify("No bash background jobs in this session.", "info");
                return;
            }
            ctx.ui.notify([...jobs.values()].map(renderJob).join("\n\n"), "info");
        },
    });

    pi.registerCommand("bg-tail", {
        description:
            "Show output tail for a backgrounded bash job: /bg-tail [job-id]",
        handler: async (args, ctx) => {
            const id = args.trim();
            const job = id ? jobs.get(id) : latestJob();
            if (!job) {
                ctx.ui.notify(
                    id
                        ? `No such job: ${id}`
                        : "No bash background jobs in this session.",
                    "warning"
                );
                return;
            }
            const content = readTail(job.logPath, 6000);
            ctx.ui.notify(`${renderJob(job)}\n\n${content || "(no output yet)"}`, "info");
        },
    });

    pi.registerCommand("bg-kill", {
        description: "Kill a backgrounded bash job: /bg-kill <job-id>",
        handler: async (args, ctx) => {
            const id = args.trim();
            const job = id ? jobs.get(id) : undefined;
            if (!job) {
                ctx.ui.notify(
                    id ? `No such job: ${id}` : "Usage: /bg-kill <job-id>",
                    "warning"
                );
                return;
            }
            if (job.status !== "running") {
                ctx.ui.notify(`${job.id} is already ${job.status}.`, "info");
                return;
            }
            job.status = "killed";
            killProcessGroup(job.pid, "SIGTERM");
            ctx.ui.notify(`Killed ${job.id}.`, "info");
            updateStatus(ctx, activeRun, jobs);
        },
    });

    pi.on("session_start", async (_event, ctx) => {
        updateStatus(ctx, activeRun, jobs);
    });

    pi.on("session_shutdown", async () => {
        if (activeRun) {
            activeRun.job.status = "killed";
            killProcessGroup(activeRun.job.pid, "SIGTERM");
        }
    });
}
