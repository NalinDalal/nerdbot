import { describe, it, expect } from "vitest";
import { filterLibraryDocs, libraryKindLabel, libraryProvenance } from "./views-library";
import type { LibraryDoc } from "./types";

const doc = (over: Partial<LibraryDoc> = {}): LibraryDoc => ({
  id: "lib_1",
  project_id: "prj_1",
  kind: "note",
  title: "Meeting notes",
  content: "ship the library",
  source: "note",
  teammate_id: "",
  tainted: false,
  version: 1,
  created_at: "2026-11-09T10:00:00+00:00",
  updated_at: "2026-11-09T10:00:00+00:00",
  ...over,
});

describe("filterLibraryDocs", () => {
  const rows = [
    { doc: doc(), projectName: "one" },
    { doc: doc({ id: "lib_2", title: "Roadmap", content: "quarterly plans" }), projectName: "two" },
    { doc: doc({ id: "lib_3", title: "Upload", kind: "upload", source: "spec.md" }), projectName: "one" },
  ];

  it("returns everything for an empty query", () => {
    expect(filterLibraryDocs(rows, "")).toHaveLength(3);
    expect(filterLibraryDocs(rows, "   ")).toHaveLength(3);
  });

  it("matches title case-insensitively", () => {
    expect(filterLibraryDocs(rows, "ROADMAP").map((r) => r.doc.id)).toEqual(["lib_2"]);
  });

  it("matches content and source, not just titles", () => {
    expect(filterLibraryDocs(rows, "quarterly").map((r) => r.doc.id)).toEqual(["lib_2"]);
    expect(filterLibraryDocs(rows, "spec.md").map((r) => r.doc.id)).toEqual(["lib_3"]);
  });

  it("keeps the row shape so callers still see projectName", () => {
    const hit = filterLibraryDocs(rows, "roadmap");
    expect(hit[0].projectName).toBe("two");
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterLibraryDocs(rows, "zzz-nothing")).toEqual([]);
  });
});

describe("libraryProvenance", () => {
  const nameOf = (id: string) => (id === "tm_1" ? "Coder" : "a teammate");

  it("reads as the owner when no bot wrote it", () => {
    expect(libraryProvenance(doc(), nameOf)).toBe("Last written by you");
  });

  it("names the bot and flags the taint", () => {
    const line = libraryProvenance(doc({ teammate_id: "tm_1", tainted: true }), nameOf);
    expect(line).toContain("Last written by Coder");
    expect(line).toContain("bot-written");
  });

  it("names the bot even when the doc is not tainted", () => {
    expect(libraryProvenance(doc({ teammate_id: "tm_1" }), nameOf)).toBe(
      "Last written by Coder",
    );
  });
});

describe("libraryKindLabel", () => {
  it("labels the three kinds", () => {
    expect(libraryKindLabel("note")).toBe("Note");
    expect(libraryKindLabel("doc")).toBe("Document");
    expect(libraryKindLabel("upload")).toBe("Upload");
  });

  it("falls back to Note for an unknown kind", () => {
    expect(libraryKindLabel("mystery")).toBe("Note");
  });
});
