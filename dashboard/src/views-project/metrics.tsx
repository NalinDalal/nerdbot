import { api } from "../api";
import { Button, EmptyState, ErrorState, LOG_SHELL, LoadingState, useAsync } from "../components";
export function MetricsTab({ projectId }: { projectId: string }) {
  const metrics = useAsync(() => api.projectMetrics(projectId), [projectId]);
  return (
    <div>
      <div className="flex items-center gap-3" style={{ marginBottom: 12 }}>
        <Button onClick={metrics.reload}>Refresh</Button>
      </div>
      {metrics.loading ? (
        <LoadingState />
      ) : metrics.error ? (
        <ErrorState error={metrics.error} onRetry={metrics.reload} />
      ) : metrics.data ? (
        <pre className={LOG_SHELL}>{JSON.stringify(metrics.data, null, 2)}</pre>
      ) : (
        <EmptyState title="No metrics" />
      )}
    </div>
  );
}
