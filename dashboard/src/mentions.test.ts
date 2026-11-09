import { describe, it, expect } from "vitest";
import { insertMention, mentionHandle, splitMentions } from "./mentions";

describe("mentionHandle", () => {
  it("prefers the slug, then the name, then the id", () => {
    expect(mentionHandle({ slug: "ceo", name: "CEO", id: "tm_1" })).toBe("ceo");
    expect(mentionHandle({ slug: "", name: "CEO", id: "tm_1" })).toBe("CEO");
    expect(mentionHandle({ slug: "", name: "", id: "tm_1" })).toBe("tm_1");
  });
});

describe("insertMention", () => {
  it("starts a draft with the mention", () => {
    expect(insertMention("", "ceo")).toBe("@ceo ");
  });
  it("appends with exactly one space after existing text", () => {
    expect(insertMention("look at this", "ceo")).toBe("look at this @ceo ");
    expect(insertMention("look at this   ", "ceo")).toBe("look at this @ceo ");
  });
  it("can chain mentions without stacking spaces", () => {
    expect(insertMention(insertMention("", "ceo"), "research")).toBe("@ceo @research ");
  });
});

describe("splitMentions", () => {
  it("keeps plain text as one segment", () => {
    expect(splitMentions("hello there")).toEqual([{ text: "hello there", mention: false }]);
  });
  it("splits a leading mention", () => {
    expect(splitMentions("@ceo plan this")).toEqual([
      { text: "@ceo", mention: true },
      { text: " plan this", mention: false },
    ]);
  });
  it("cuts a mention at punctuation so trailing words stay plain", () => {
    expect(splitMentions("ask @research-1, now")).toEqual([
      { text: "ask ", mention: false },
      { text: "@research-1", mention: true },
      { text: ", now", mention: false },
    ]);
  });
  it("marks only @-prefixed segments as mentions", () => {
    const parts = splitMentions("email me @ home");
    expect(parts.every((p) => !p.mention)).toBe(true);
  });
});
