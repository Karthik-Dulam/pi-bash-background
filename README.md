# Bash Background Extension

Minimal Pi extension that overrides the built-in `bash` tool so a foreground shell command can be detached with `Ctrl+B`.

## Behavior

- Agent calls `bash` normally.
- While the command is running, the status bar shows the background shortcuts.
- Press `Ctrl+B` to return control to Pi immediately and let the agent keep working.
- Press `Ctrl+Shift+B` to return control to Pi immediately and wait for the completion notification.
- The tool result tells the agent how long the command ran before being backgrounded.
- The shell process keeps running detached and writes output to `~/.pi/agent/bash-background/<job-id>.log`.
- When the process exits, the extension emits a visible completion message with the output tail.

## Commands

- `/bg-jobs` — list jobs started in the current Pi session.
- `/bg-tail [job-id]` — show recent output for a job, defaulting to the latest job.
- `/bg-kill <job-id>` — terminate a running job's process group.

## Notes

- This is intentionally small and only targets bash backgrounding.
- Background job metadata is in-memory for the current Pi session; output logs remain on disk.
- If Pi exits after a command has been backgrounded, the detached process should keep running and continue writing to its log file.
