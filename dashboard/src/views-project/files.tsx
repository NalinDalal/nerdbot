/** The workspace's files, across every task checkout.
 *
 *  Each task runs in its own isolated checkout. This tab is the workspace
 *  view of them: what was produced, by which task, on which branch.
 */
import { api } from "../api";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  ShortId,
  StatStrip,
  TABLE_SHELL,
  TABLE_TD,
  TABLE_TH,
  useAsync,
} from "../components";

export function FilesTab({ projectId }: { projectId: string }) {
  const list = useAsync(() => api.projectWorkspaceFiles(projectId), [projectId]);
  const checkouts = list.data?.checkouts ?? [];

  return (
    <div>
      {list.loading ? (
        <LoadingState lines={3} />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : checkouts.length === 0 ? (
        <EmptyState
          title="No files yet"
          hint="A task writes into its own isolated checkout. Run a task, or press Ensure workspace on one, and its files appear here."
        />
      ) : (
        <>
          <StatStrip
            className="mb-4"
            items={[
              { label: "checkouts", value: checkouts.length },
              { label: "files", value: list.data?.file_count ?? 0 },
            ]}
          />
          {checkouts.map((checkout) => (
            <div key={checkout.task_id} className="mb-6 last:mb-0">
              <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <a
                  href={`#/p/${projectId}/t/${checkout.task_id}`}
                  className="text-step-0 font-medium text-[var(--text)] hover:underline"
                >
                  {checkout.task_description || "Untitled task"}
                </a>
                <span className="mono text-step--2 text-[var(--faint)]">
                  <ShortId id={checkout.task_id} />
                  {checkout.branch ? ` · ${checkout.branch}` : ""}
                </span>
              </div>
              <div className={TABLE_SHELL}>
                <table className="w-full table-fixed">
                  <thead>
                    <tr>
                      <th className={TABLE_TH}>File</th>
                      <th className={`${TABLE_TH} w-[8rem]`}>Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checkout.files.map((file) => (
                      <tr
                        key={file.path}
                        className="transition-colors hover:bg-[var(--surface-2)]"
                      >
                        <td className={TABLE_TD}>
                          <span className="mono block truncate text-step--1 text-[var(--text-soft)]" title={file.path}>
                            {file.path}
                          </span>
                        </td>
                        <td className={TABLE_TD}>
                          <span className="text-step--1 text-[var(--muted)]">
                            {file.size} B
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
