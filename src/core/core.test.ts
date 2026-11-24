import { describe, expect, it } from "vitest";
import { detectWithRules, locate, luhnValid, resolveOverlaps } from "./detectors";
import { redact, restore } from "./vault";
import { assertNoRulePii } from "./gate";
import { clean } from "./pipeline";

const types = (t: string) => detectWithRules(t).map((e) => `${e.type}:${e.value}`);

describe("rules", () => {
  it("finds Nigerian phone numbers in common formats", () => {
    expect(types("call 08031234567 or +234 803 123 4567 or 0703-123-4567")).toEqual([
      "PHONE:08031234567",
      "PHONE:+234 803 123 4567",
      "PHONE:0703-123-4567",
    ]);
  });

  it("labels 11-digit numbers by context", () => {
    expect(types("My BVN is 22123456789")).toEqual(["BVN:22123456789"]);
    expect(types("NIN: 12345678901")).toEqual(["NIN:12345678901"]);
    expect(types("ref 12345678901")).toEqual(["ID_NUMBER:12345678901"]);
    expect(types("- BVN: 22123456789\n- NIN: 12345678901")).toEqual(["BVN:22123456789", "NIN:12345678901"]);
  });

  it("only masks 10-digit numbers near banking words", () => {
    expect(types("GTBank 0123456789")).toEqual(["ACCOUNT:0123456789"]);
    expect(types("order number 0123456789 shipped")).toEqual([]);
  });

  it("checks card numbers with Luhn", () => {
    expect(luhnValid("4111 1111 1111 1111")).toBe(true);
    expect(types("card 4111 1111 1111 1111")).toEqual(["CARD:4111 1111 1111 1111"]);
    expect(types("card 4111 1111 1111 1112")).not.toContain("CARD:4111 1111 1111 1112");
  });

  it("finds emails, addresses and birth dates", () => {
    const t = types("Email noah@futa.edu.ng, I live at No. 12 Adebayo Street, date of birth 04/07/2005");
    expect(t).toContain("EMAIL:noah@futa.edu.ng");
    expect(t.some((x) => x.startsWith("ADDRESS:") && x.includes("Adebayo Street"))).toBe(true);
    expect(t).toContain("DOB:04/07/2005");
  });

  it("does not call every date a birth date", () => {
    expect(types("meeting on 04/07/2026")).toEqual([]);
  });
});

describe("names", () => {
  it("hides names after a title without the model", () => {
    expect(types("My guardian, Mr. Chinedu Eze, is on")).toContain("NAME:Chinedu Eze");
    expect(types("Ask Alhaji Musa")).toContain("NAME:Musa");
  });

  it("hides names introduced by common phrases, without the model", () => {
    const t = types("Hi, I'm Tunde Bakare. My friend Adaeze Okonkwo said hi.\n\nThanks,\nTunde");
    expect(t).toEqual(expect.arrayContaining(["NAME:Tunde Bakare", "NAME:Adaeze Okonkwo", "NAME:Tunde"]));
  });

  it("does not treat ordinary words after cues as names", () => {
    expect(types("Hi there, I am interested. Hello Everyone")).toEqual([]);
    expect(types("I am a student")).toEqual([]);
  });

  it("hides a first name on its own once the full name is known", () => {
    const r = clean("My name is Tunde Bakare.\nThanks,\nTunde", {
      deviceFindings: [{ type: "NAME", text: "Tunde Bakare" }],
    });
    expect(r.cleaned).toBe("My name is [NAME_1].\nThanks,\n[NAME_2]");
  });

  it("does not match a name inside a longer word", () => {
    const r = clean("Adaeze said hi", { deviceFindings: [{ type: "NAME", text: "Ada" }] });
    expect(r.cleaned).toBe("Adaeze said hi");
  });
});

describe("vault", () => {
  it("round-trips and reuses tokens for the same value", () => {
    const text = "Ada (08031234567) said call +234 803 123 4567";
    const ents = resolveOverlaps([
      ...detectWithRules(text),
      ...locate(text, [{ type: "NAME", text: "Ada" }]),
    ]);
    const { text: cleaned, vault } = redact(text, ents);
    expect(cleaned).toBe("[NAME_1] ([PHONE_1]) said call [PHONE_1]");
    expect(restore("Hi [NAME_1], I will call [PHONE_1]", vault)).toBe("Hi Ada, I will call 08031234567");
  });

  it("continues numbering from an existing vault", () => {
    const first = redact("a@b.com", detectWithRules("a@b.com"));
    const second = redact("c@d.com and a@b.com", detectWithRules("c@d.com and a@b.com"), first.vault);
    expect(second.text).toBe("[EMAIL_2] and [EMAIL_1]");
  });
});

describe("privacy gate", () => {
  it("blocks text that still has rule-detectable data", () => {
    expect(() => assertNoRulePii("call 08031234567")).toThrow();
    expect(() => assertNoRulePii("call [PHONE_1]")).not.toThrow();
  });
});
