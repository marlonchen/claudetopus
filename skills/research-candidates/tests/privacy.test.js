"use strict";

const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const { describe, it } = require("node:test");
const { CLASSES, refusalCode, scan } = require("../scripts/lib/privacy");

// Seam 2: the privacy matcher (SKILL.md step 6.3) on the spellings that would
// be slow to plant through a command.

const VALUES = {
  "ballot-id": ["xx-exampleton-1"],
  "private-string": ["Springfield Township", "Pct 12", "BS-0412", "Precinct 2024", "Ballot A"],
  address: ["123 Elm Street Apt 4, Springfield, XX 99999", "123 Elm Street"],
  zip: ["99999"],
  label: ["addr-mom"],
  key: ["k3yV4lue0123456789"],
};
const ALL = Object.keys(CLASSES);
// The classes that match `text`, in report order.
const classes = (text, values = VALUES, only = ALL) => [
  ...new Set(scan(text, values, only).map((m) => m.class)),
];

describe("privacy matcher: whole phrases on word boundaries", () => {
  it("matches a phrase in any case and across URL separators", () => {
    for (const text of [
      "Springfield Township",
      "SPRINGFIELD   TOWNSHIP",
      "https://example.com/springfield-township/",
      "/springfield_township",
      "springfield.township",
      "q=springfield+township",
    ]) {
      assert.deepEqual(classes(text), ["private-string"], text);
    }
  });

  it("never matches inside a longer word", () => {
    for (const text of ["Field Township", "springfieldtownship", "Springfield Townships"]) {
      assert.deepEqual(classes(text), [], text);
    }
  });

  it('reads "ballot-a" and "ballot a" as the same phrase, but not "ballot-ab"', () => {
    assert.deepEqual(classes("/ballot-a/"), ["private-string"]);
    assert.deepEqual(classes("ballot a"), ["private-string"]);
    assert.deepEqual(classes("/ballot-ab/"), []);
    const hyphenated = { "private-string": ["ballot-a"] };
    assert.deepEqual(classes("Ballot A", hyphenated), ["private-string"]);
  });
});

describe("privacy matcher: every normalization variant, refusing on any", () => {
  it("finds a phrase split by a soft hyphen or zero-width character", () => {
    for (const text of [
      "Spring­field Township",
      "Spring​field Township",
      "Spring‍field Township",
      "Springfield​ Township",
      "SpringfieldㅤTownship",
      "Spring&shy;field Township",
      "Spring%C2%ADfield%20Township",
    ]) {
      assert.deepEqual(classes(text), ["private-string"], JSON.stringify(text));
    }
  });

  it("finds fullwidth, mathematical and ligature spellings through NFKC", () => {
    for (const text of [
      "Ｓｐｒｉｎｇｆｉｅｌｄ Township",
      "\u{1d412}\u{1d429}\u{1d42b}\u{1d422}\u{1d427}\u{1d420}\u{1d41f}\u{1d422}\u{1d41e}\u{1d425}\u{1d41d} Township",
      "Springﬁeld Township",
      "springfield／township",
    ]) {
      assert.deepEqual(classes(text), ["private-string"], JSON.stringify(text));
    }
  });

  it("finds Township¹, which NFKC alone would read as township1", () => {
    assert.deepEqual(classes("Springfield Township¹"), ["private-string"]);
  });

  it("folds curly quotes and every dash", () => {
    const values = { "private-string": ["O'Brien Hall", "Ward 3-B"] };
    assert.deepEqual(classes("O’Brien Hall", values), ["private-string"]);
    assert.deepEqual(classes("Ward 3–B", values), ["private-string"]);
    assert.deepEqual(classes("Ward 3−B", values), ["private-string"]);
  });

  it("decodes entities and double URL encoding", () => {
    assert.deepEqual(classes("addr&#45;mom"), ["label"]);
    assert.deepEqual(classes("addr%252Dmom"), ["label"]);
  });

  it("decodes every entity as browsers do, numeric ones without a `;` too", () => {
    for (const text of [
      "Springfield&ensp;Township",
      "Springfield&emsp;Township",
      "Springfield&thinsp;Township",
      "Springfield&Tab;Township",
      "Springfield&NewLine;Township",
      "Spring&ZeroWidthSpace;field Township",
      // Windows-1252: &#151; is an em dash, which the dash fold reads as a hyphen.
      "Springfield&#151;Township",
    ]) {
      assert.deepEqual(classes(text), ["private-string"], text);
    }
    assert.deepEqual(classes("addr&#45mom"), ["label"]);
    assert.deepEqual(classes("addr&#x2dmom"), ["label"]);
  });

  it("decodes latin1 percent-escapes and folds ß and final sigma", () => {
    const values = { "private-string": ["Peña Hall", "Straße Nord", "Οδος"] };
    assert.deepEqual(classes("/Pe%F1a-Hall", values), ["private-string"]);
    assert.deepEqual(classes("/STRASSE-NORD/", values), ["private-string"]);
    assert.deepEqual(classes("/ΟΔΟΣ/", values), ["private-string"]);
  });

  it("normalizes each value like the form it is matched against", () => {
    const values = { "private-string": ["Spring­field Township", "Ｌｉｎｃｏｌｎ Gym"] };
    assert.deepEqual(classes("springfield-township", values), ["private-string"]);
    assert.deepEqual(classes("Lincoln Gym", values), ["private-string"]);
  });
});

describe("privacy matcher: digit runs, ZIPs and the ballot id", () => {
  it('matches a short digit run only beside its entry\'s other words ("Pct 12")', () => {
    assert.deepEqual(classes("Pct 12"), ["private-string"]);
    assert.deepEqual(classes("/pct-12/"), ["private-string"]);
    assert.deepEqual(classes("12 pct"), ["private-string"]);
    assert.deepEqual(classes("page 12"), []);
    assert.deepEqual(classes("/12/"), []);
  });

  it("reads query and path punctuation as spaces (?pct=12)", () => {
    for (const text of [
      "?pct=12",
      "/pct:12/",
      "?Pct%3D12",
      "/pct~12",
      "?a=1;pct=12",
      "?precinct=2024",
      "?ballot=xx,exampleton,1",
      "?t=springfield&township",
      "?addr=123+Elm+Street",
    ]) {
      assert.notDeepEqual(classes(text), [], text);
    }
    assert.deepEqual(classes("?page=12"), []);
  });

  it("matches a run of 4+ digits alone, but a year-shaped run only beside its words", () => {
    assert.deepEqual(classes("style=0412"), ["private-string"]);
    assert.deepEqual(classes("bs0412x"), ["private-string"]);
    assert.deepEqual(classes("10412"), []);
    assert.deepEqual(classes("elections 2024 results"), []);
    assert.deepEqual(classes("precinct-2024"), ["private-string"]);
  });

  it("matches a ZIP only as a standalone 5-digit token", () => {
    for (const text of ["?zip=99999", "XX 99999-1234", "zip99999", "９９９９９"]) {
      assert.deepEqual(classes(text, { zip: ["99999"] }), ["zip"], text);
    }
    for (const text of ["1999990", "999990", "9999"]) {
      assert.deepEqual(classes(text, { zip: ["99999"] }), [], text);
    }
  });

  it("matches the ballot id in its hyphen, underscore and slash forms", () => {
    for (const text of [
      "/xx-exampleton-1/",
      "xx_exampleton_1",
      "/xx/exampleton/1",
      "XX Exampleton 1",
    ]) {
      assert.deepEqual(classes(text), ["ballot-id"], text);
    }
    assert.deepEqual(classes("/xx-exampleton-12/"), []);
    assert.deepEqual(classes("/xx-exampletonia-1/"), []);
  });
});

describe("privacy matcher: what callers pass and get back", () => {
  it("checks only the classes the caller asks for", () => {
    const text = "addr-mom at 123 Elm Street Apt 4, 99999";
    assert.deepEqual(classes(text), ["address", "zip", "label"]);
    assert.deepEqual(classes(text, VALUES, ["zip"]), ["zip"]);
  });

  it("returns lines and classes only, never the text", () => {
    const matches = scan("ok\nsee Springfield\nTownship\nand addr-mom", VALUES, ALL);
    assert.deepEqual(matches, [
      { line: 2, class: "private-string" },
      { line: 4, class: "label" },
    ]);
  });

  it("locates a match by its line after many replacements before it", () => {
    const text = `${"A&amp;B ’x’ Ｑ\n".repeat(50)}see addr&#45;mom\n${"ok\n".repeat(5)}SPRINGFIELD township`;
    assert.deepEqual(scan(text, VALUES, ALL), [
      { line: 51, class: "label" },
      { line: 57, class: "private-string" },
    ]);
  });

  it("scans a 10 MB page in memory proportional to its replacements", () => {
    // A heap far below one number per UTF-16 unit for every fold (PR #9 review: 3.5 GB).
    const script = `
      const { scan } = require(${JSON.stringify(require.resolve("../scripts/lib/privacy"))});
      const text = "Lorem ipsum dolor sit amet &amp; elit.\\n".repeat(260000) + "addr-mom";
      const hits = scan(text, { label: ["addr-mom"] }, ["label"]);
      process.stdout.write(JSON.stringify(hits));
    `;
    const run = spawnSync(process.execPath, ["--max-old-space-size=400", "-e", script], {
      encoding: "utf8",
      env: process.env,
    });
    assert.strictEqual(run.status, 0, run.stderr.slice(0, 500));
    assert.deepEqual(JSON.parse(run.stdout), [{ line: 260001, class: "label" }]);
  });

  it("matches a key value anywhere, as written", () => {
    assert.deepEqual(classes("?api_key=k3yV4lue0123456789&x=1"), ["key"]);
    assert.deepEqual(classes("x=K3YV4LUE0123456789"), []);
  });

  it("skips values with no letter or digit instead of matching every separator", () => {
    const values = { label: ["", "   "], "private-string": ["­", ".", "-", " / "] };
    assert.deepEqual(classes("https://a.example/x-y/spring­field", values), []);
  });

  it("trims a key value before matching it", () => {
    assert.deepEqual(classes("?k=k3yV4lue0123456789", { key: ["k3yV4lue0123456789\n"] }), ["key"]);
    assert.deepEqual(classes("anything", { key: ["  "] }), []);
  });

  it("refuses with the first class in report order", () => {
    assert.equal(
      refusalCode([
        { line: 1, class: "label" },
        { line: 1, class: "ballot-id" },
      ]),
      "private-ballot-id",
    );
    assert.equal(refusalCode([]), null);
    assert.throws(() => scan("x", {}, ["street"]), /unknown privacy class/);
  });
});
