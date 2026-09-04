import { CopyButton } from "./CopyButton";

export function CommandBlock({ command, className = "" }: { command: string; className?: string }) {
  return (
    <div
      className={`flex items-start justify-between gap-3 overflow-x-auto rounded-md bg-ink px-4 py-3 ${className}`}
    >
      <code className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-paper">
        {command}
      </code>
      <CopyButton text={command} className="mt-0.5" />
    </div>
  );
}
