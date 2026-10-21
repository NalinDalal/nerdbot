import { useState } from "react";
import { api } from "../api";
import { notifyError } from "../app";
import { Button, ERROR_BOX, LOG_SHELL } from "../components";
export function BackupTab({ projectId }: { projectId: string }) {
  const [manifest, setManifest] = useState("");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setError(null);
    try {
      const data = await api.exportBackup(projectId);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `nerdbot-backup-${projectId}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      notifyError(err);
    }
  };

  const runValidate = async () => {
    setError(null);
    setResult(null);
    try {
      const parsed: unknown = JSON.parse(manifest || "{}");
      setResult((await api.validateBackup(projectId, parsed)) as Record<string, unknown>);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      notifyError(err);
    }
  };

  const runImport = async (dryRun: boolean) => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const parsed: unknown = JSON.parse(manifest || "{}");
      setResult((await api.importBackup(projectId, parsed, dryRun)) as Record<string, unknown>);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3" style={{ marginBottom: 12 }}>
        <Button variant="primary" onClick={() => void download()}>
          Export backup
        </Button>
      </div>
      <h2>Validate / import</h2>
      <p className="text-[var(--muted)]">Paste a manifest, validate it, dry-run first, then apply.</p>
      {error ? <div className={ERROR_BOX}>{error}</div> : null}
      <label className="flex flex-col gap-1.5">
        <span>Manifest JSON</span>
        <textarea rows={6} value={manifest} onChange={(e) => setManifest(e.target.value)} placeholder='{"version": 1, …}' />
      </label>
      <div className="flex items-center gap-3" style={{ marginBottom: 12 }}>
        <Button onClick={() => void runValidate()}>Validate</Button>
        <Button onClick={() => void runImport(true)} disabled={busy}>
          Dry run
        </Button>
        <Button variant="danger" onClick={() => void runImport(false)} disabled={busy}>
          Apply import
        </Button>
      </div>
      {result ? <pre className={LOG_SHELL}>{JSON.stringify(result, null, 2)}</pre> : null}
    </div>
  );
}
