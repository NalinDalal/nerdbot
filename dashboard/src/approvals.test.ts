/** An expired, undecided approval is not actionable.
 *
 *  The dashboard's attention banner and the project's approvals tab both
 *  decide what the owner can act on. An approval past its expiry cannot be
 *  decided — the API answers 410 — so it must not be offered as a decision.
 *  This mirrors the server rule in `store.approval_is_pending`.
 */
import { describe, expect, it } from "vitest";
import { approvalIsPending } from "./components";
import { summarize } from "./views-home";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const PAST = "2026-10-18T12:52:27.788958Z";
const FUTURE = "2026-10-21T12:30:00Z";

describe("approvalIsPending", () => {
  it("treats an undecided approval with no expiry as pending", () => {
    expect(approvalIsPending({ decision: "pending", expires_at: null }, NOW)).toBe(true);
  });

  it("treats an undecided approval inside its expiry window as pending", () => {
    expect(approvalIsPending({ decision: "pending", expires_at: FUTURE }, NOW)).toBe(true);
  });

  it("treats an undecided approval past its expiry as not pending", () => {
    expect(approvalIsPending({ decision: "pending", expires_at: PAST }, NOW)).toBe(false);
  });

  it("treats a decided approval as not pending", () => {
    expect(approvalIsPending({ decision: "approved", expires_at: FUTURE }, NOW)).toBe(false);
    expect(approvalIsPending({ decision: "denied", expires_at: null }, NOW)).toBe(false);
  });

  it("treats a missing decision as pending (legacy rows)", () => {
    expect(approvalIsPending({ expires_at: FUTURE }, NOW)).toBe(true);
  });

  it("treats an unparseable expiry as pending rather than hiding it", () => {
    expect(approvalIsPending({ decision: "pending", expires_at: "not-a-date" }, NOW)).toBe(true);
  });
});

describe("Command Center summary", () => {
  const bundle = (approvals: Array<Record<string, unknown>>) => ({
    bundles: [
      {
        project: { id: "prj_1", owner: "local-owner", repository: "demo" },
        tasks: [],
        runs: [],
        approvals: approvals as never,
        teammates: [],
      },
    ],
    teams: [],
    bots: [],
  });

  it("does not surface an expired approval as a pending decision", () => {
    const summary = summarize(
      bundle([
        { id: "apr_live", decision: "pending", expires_at: FUTURE },
        { id: "apr_dead", decision: "pending", expires_at: PAST },
      ]),
      NOW,
    );
    const ids = summary.pendingApprovals.map((entry) => entry.approval.id);
    expect(ids).toEqual(["apr_live"]);
  });

  it("surfaces an undecided approval with no expiry as a pending decision", () => {
    const summary = summarize(
      bundle([{ id: "apr_forever", decision: "pending", expires_at: null }]),
      NOW,
    );
    expect(summary.pendingApprovals.map((entry) => entry.approval.id)).toEqual(["apr_forever"]);
  });

  it("does not surface a decided approval as pending", () => {
    const summary = summarize(
      bundle([{ id: "apr_done", decision: "approved", expires_at: null }]),
      NOW,
    );
    expect(summary.pendingApprovals).toEqual([]);
  });
});
